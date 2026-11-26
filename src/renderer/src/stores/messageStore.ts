import { create } from 'zustand'
import type { DecodedMessage, SearchRequest, TimeRange } from '@shared/models'
import { RENDERER_ROW_CAP } from '@shared/models'
import { ApiError, call, subscribe } from '../lib/api'

export type BrowseMode = 'idle' | 'searching' | 'tailing'

export interface BrowseFilters {
  topic: string
  filter: string
  partition: number | null
  startOffset: string
  useTimeRange: boolean
  fromMs: number | null
  toMs: number | null
  maxResults: number
  fromBeginning: boolean
}

export const DEFAULT_FILTERS: BrowseFilters = {
  topic: '',
  filter: '',
  partition: null,
  startOffset: '',
  useTimeRange: false,
  fromMs: null,
  toMs: null,
  maxResults: 500,
  fromBeginning: false
}

/**
 * One search workspace. Tabs are fully independent — separate filters, results
 * and job — so several topics can be scanned at the same time. The backend job
 * registry is already keyed by jobId, so concurrency needs nothing extra there.
 */
export interface BrowseTab {
  id: string
  filters: BrowseFilters
  messages: DecodedMessage[]
  selected: DecodedMessage | null
  mode: BrowseMode
  jobId: string | null
  scanned: number
  matched: number
  elapsedMs: number
  error: string | null
  stoppedEarly: boolean
  newestFirst: boolean
}

interface BrowseState {
  tabs: BrowseTab[]
  activeId: string

  addTab: (topic?: string) => string
  closeTab: (id: string) => void
  setActive: (id: string) => void

  setFilters: (id: string, patch: Partial<BrowseFilters>) => void
  setNewestFirst: (id: string, value: boolean) => void
  select: (id: string, message: DecodedMessage | null) => void
  search: (id: string, clusterId: string) => Promise<void>
  tail: (id: string, clusterId: string) => Promise<void>
  stop: (id: string) => void
  clear: (id: string) => void
  /** Subscribes to job events once; routes each by jobId to its tab. */
  watch: () => () => void
}

let tabCounter = 0
function newTab(topic = ''): BrowseTab {
  tabCounter += 1
  return {
    id: `tab-${tabCounter}`,
    filters: { ...DEFAULT_FILTERS, topic },
    messages: [],
    selected: null,
    mode: 'idle',
    jobId: null,
    scanned: 0,
    matched: 0,
    elapsedMs: 0,
    error: null,
    stoppedEarly: false,
    newestFirst: true
  }
}

const FIRST = newTab()

export const useMessages = create<BrowseState>((set, get) => {
  /** Applies a patch to one tab, leaving the others untouched. */
  const patch = (id: string, changes: Partial<BrowseTab>): void =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...changes } : t))
    }))

  /** Routes a job event to whichever tab owns that job. */
  const patchByJob = (
    jobId: string,
    changes: (tab: BrowseTab) => Partial<BrowseTab>
  ): void =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.jobId === jobId ? { ...t, ...changes(t) } : t))
    }))

  return {
    tabs: [FIRST],
    activeId: FIRST.id,

    addTab: (topic) => {
      const tab = newTab(topic)
      set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }))
      return tab.id
    },

    closeTab: (id) => {
      const tab = get().tabs.find((t) => t.id === id)
      // Closing a tab must not leave its consumer running in the background.
      if (tab?.jobId) void call('job:cancel', tab.jobId)

      set((s) => {
        const remaining = s.tabs.filter((t) => t.id !== id)
        if (remaining.length === 0) {
          const fresh = newTab()
          return { tabs: [fresh], activeId: fresh.id }
        }
        const activeId =
          s.activeId === id ? (remaining[remaining.length - 1]?.id ?? '') : s.activeId
        return { tabs: remaining, activeId }
      })
    },

    setActive: (activeId) => set({ activeId }),

    setFilters: (id, changes) =>
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, filters: { ...t.filters, ...changes } } : t))
      })),

    setNewestFirst: (id, newestFirst) => patch(id, { newestFirst }),
    select: (id, selected) => patch(id, { selected }),

    search: async (id, clusterId) => {
      const tab = get().tabs.find((t) => t.id === id)
      if (!tab) return
      const { filters } = tab

      patch(id, {
        messages: [],
        selected: null,
        error: null,
        scanned: 0,
        matched: 0,
        stoppedEarly: false
      })

      const timeRange: TimeRange | undefined =
        filters.useTimeRange && (filters.fromMs || filters.toMs)
          ? { fromMs: filters.fromMs ?? undefined, toMs: filters.toMs ?? undefined }
          : undefined

      const request: SearchRequest = {
        clusterId,
        topic: filters.topic,
        filter: filters.filter || undefined,
        partition: filters.partition ?? undefined,
        startOffset: filters.startOffset || undefined,
        timeRange,
        maxResults: filters.maxResults,
        fromBeginning: filters.fromBeginning
      }

      try {
        const { jobId } = await call('consume:search', request)
        patch(id, { jobId, mode: 'searching' })
      } catch (err) {
        patch(id, {
          mode: 'idle',
          error: err instanceof ApiError ? err.message : 'Search failed.'
        })
      }
    },

    tail: async (id, clusterId) => {
      const tab = get().tabs.find((t) => t.id === id)
      if (!tab) return

      patch(id, {
        messages: [],
        selected: null,
        error: null,
        scanned: 0,
        matched: 0,
        stoppedEarly: false
      })

      try {
        const { jobId } = await call('consume:tail:start', {
          clusterId,
          topic: tab.filters.topic,
          filter: tab.filters.filter || undefined,
          partition: tab.filters.partition ?? undefined
        })
        patch(id, { jobId, mode: 'tailing' })
      } catch (err) {
        patch(id, { mode: 'idle', error: err instanceof ApiError ? err.message : 'Tail failed.' })
      }
    },

    stop: (id) => {
      const tab = get().tabs.find((t) => t.id === id)
      if (tab?.jobId) void call('job:cancel', tab.jobId)
      patch(id, { mode: 'idle' })
    },

    clear: (id) =>
      patch(id, {
        messages: [],
        selected: null,
        scanned: 0,
        matched: 0,
        error: null,
        stoppedEarly: false
      }),

    watch: () => {
      const unsubs = [
        subscribe('job:messages', ({ jobId, messages }) => {
          patchByJob(jobId, (tab) => {
            const next = tab.messages.concat(messages)
            // Evict oldest rather than letting a long tail grow without bound.
            return {
              messages: next.length > RENDERER_ROW_CAP ? next.slice(-RENDERER_ROW_CAP) : next
            }
          })
        }),

        subscribe('job:progress', ({ jobId, scanned, matched }) => {
          patchByJob(jobId, () => ({ scanned, matched }))
        }),

        subscribe('job:done', ({ jobId, scanned, matched, elapsedMs, stoppedByGuard }) => {
          patchByJob(jobId, () => ({
            mode: 'idle' as BrowseMode,
            jobId: null,
            scanned,
            matched,
            elapsedMs,
            stoppedEarly: !!stoppedByGuard
          }))
        }),

        subscribe('job:error', ({ jobId, error }) => {
          patchByJob(jobId, () => ({
            mode: 'idle' as BrowseMode,
            jobId: null,
            error: error.message
          }))
        })
      ]
      return () => unsubs.forEach((u) => u())
    }
  }
})

export function useActiveTab(): BrowseTab {
  return useMessages((s) => s.tabs.find((t) => t.id === s.activeId) ?? s.tabs[0])
}

/**
 * Applies the tab's sort order: by record timestamp, newest or oldest first.
 *
 * Reversing arrival order — what this used to do — is not the same thing. A
 * scan reads partitions concurrently, so records arrive interleaved and a
 * reversed list is only in timestamp order by luck. Partition and offset break
 * ties, which keeps records written in the same millisecond in log order rather
 * than shuffling them between renders.
 *
 * Sorting runs on every store update during a scan. `Array.sort` is TimSort, so
 * a mostly-ordered list of this size costs close to a linear pass.
 */
export function orderedMessages(tab: BrowseTab): DecodedMessage[] {
  const direction = tab.newestFirst ? -1 : 1

  return [...tab.messages].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return (a.timestamp - b.timestamp) * direction
    if (a.partition !== b.partition) return (a.partition - b.partition) * direction

    const [x, y] = [BigInt(a.offset), BigInt(b.offset)]
    if (x === y) return 0
    return (x < y ? -1 : 1) * direction
  })
}

/** Label shown on the tab strip. */
export function tabTitle(tab: BrowseTab): string {
  return tab.filters.topic.trim() || 'New search'
}
