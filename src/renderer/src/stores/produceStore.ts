import { create } from 'zustand'
import type { ProduceResult } from '@shared/models'
import type { SerdeConfig } from '@shared/serde'
import { ApiError, call } from '../lib/api'

export interface HeaderRow {
  id: number
  name: string
  value: string
}

let headerId = 0
function newHeader(): HeaderRow {
  return { id: ++headerId, name: '', value: '' }
}

/**
 * One produce workspace. Tabs live in the store rather than component state so
 * a topic's draft message, headers and last result survive navigating away to
 * another section and back — the same reason Browse tabs are store-backed.
 */
export interface ProduceTab {
  id: string
  topic: string
  key: string
  value: string
  partition: string
  headers: HeaderRow[]
  serde: SerdeConfig | null
  messageCollapsed: boolean
  busy: boolean
  result: ProduceResult | null
  error: string | null
}

let tabCounter = 0
function newTab(): ProduceTab {
  tabCounter += 1
  return {
    id: `produce-tab-${tabCounter}`,
    topic: '',
    key: '',
    value: '',
    partition: '',
    headers: [newHeader()],
    serde: null,
    messageCollapsed: false,
    busy: false,
    result: null,
    error: null
  }
}

interface ProduceState {
  tabs: ProduceTab[]
  activeId: string

  addTab: () => string
  closeTab: (id: string) => void
  setActive: (id: string) => void

  setTopic: (id: string, topic: string) => void
  setKey: (id: string, key: string) => void
  setValue: (id: string, value: string) => void
  setPartition: (id: string, partition: string) => void
  setHeaders: (id: string, headers: HeaderRow[]) => void
  setMessageCollapsed: (id: string, collapsed: boolean) => void

  /** Refetches the active topic's serde config; a response for a topic the tab
   *  has since moved on from is dropped rather than clobbering the new one. */
  loadSerde: (id: string, clusterId: string) => Promise<void>

  sendSingle: (id: string, clusterId: string) => Promise<void>
  sendFile: (
    id: string,
    clusterId: string,
    target: 'key' | 'value',
    mode: 'binary' | 'text'
  ) => Promise<void>
}

function headerMap(headers: HeaderRow[]): Record<string, string> {
  return Object.fromEntries(
    headers.filter((h) => h.name.trim() !== '').map((h) => [h.name.trim(), h.value])
  )
}

const FIRST = newTab()

export const useProduce = create<ProduceState>((set, get) => {
  const patch = (id: string, changes: Partial<ProduceTab>): void =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...changes } : t)) }))

  const run = async (id: string, send: () => Promise<ProduceResult>): Promise<void> => {
    patch(id, { busy: true, error: null, result: null })
    try {
      patch(id, { result: await send(), busy: false })
    } catch (err) {
      patch(id, { busy: false, error: err instanceof ApiError ? err.message : 'Produce failed.' })
    }
  }

  return {
    tabs: [FIRST],
    activeId: FIRST.id,

    addTab: () => {
      const tab = newTab()
      set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }))
      return tab.id
    },

    closeTab: (id) => {
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

    setTopic: (id, topic) => patch(id, { topic }),
    setKey: (id, key) => patch(id, { key }),
    setValue: (id, value) => patch(id, { value }),
    setPartition: (id, partition) => patch(id, { partition }),
    setHeaders: (id, headers) => patch(id, { headers }),
    setMessageCollapsed: (id, messageCollapsed) => patch(id, { messageCollapsed }),

    loadSerde: async (id, clusterId) => {
      const topic = get().tabs.find((t) => t.id === id)?.topic.trim()
      if (!topic) {
        patch(id, { serde: null })
        return
      }
      const stillCurrent = (): boolean => get().tabs.find((t) => t.id === id)?.topic.trim() === topic
      try {
        const cfg = await call('serde:getTopicConfig', clusterId, topic)
        if (stillCurrent()) patch(id, { serde: cfg })
      } catch {
        if (stillCurrent()) patch(id, { serde: null })
      }
    },

    sendSingle: (id, clusterId) => {
      const tab = get().tabs.find((t) => t.id === id)
      if (!tab) return Promise.resolve()
      return run(id, () =>
        call('produce:single', {
          clusterId,
          topic: tab.topic.trim(),
          key: tab.key === '' ? undefined : tab.key,
          value: tab.value,
          headers: headerMap(tab.headers),
          partition: tab.partition.trim() === '' ? undefined : Number(tab.partition)
        })
      )
    },

    sendFile: (id, clusterId, target, mode) => {
      const tab = get().tabs.find((t) => t.id === id)
      if (!tab) return Promise.resolve()
      return run(id, () =>
        call('produce:fromFile', {
          clusterId,
          topic: tab.topic.trim(),
          // Empty path: main opens the picker, so the renderer never touches fs.
          filePath: '',
          target,
          mode,
          counterpart: target === 'value' ? (tab.key === '' ? undefined : tab.key) : tab.value,
          headers: headerMap(tab.headers),
          partition: tab.partition.trim() === '' ? undefined : Number(tab.partition)
        })
      )
    }
  }
})

export function useActiveProduceTab(): ProduceTab {
  return useProduce((s) => s.tabs.find((t) => t.id === s.activeId) ?? s.tabs[0])
}

/** Label shown on the tab strip. */
export function produceTabTitle(tab: ProduceTab): string {
  return tab.topic.trim() || 'New message'
}
