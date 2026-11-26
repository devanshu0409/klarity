import { create } from 'zustand'
import type { GroupDetail, GroupSummary, LagRow } from '@shared/models'
import { ApiError, call, subscribe } from '../lib/api'

/** Points kept for the lag trend chart — 60 samples at 2s is the last two minutes. */
const HISTORY_POINTS = 60

export interface LagPoint {
  ts: number
  /** Total lag as a number: the chart only needs magnitude, not int64 exactness. */
  lag: number
}

interface GroupState {
  groups: GroupSummary[]
  loading: boolean
  error: string | null
  filter: string
  /** Only show groups that have committed offsets for this topic. */
  topicFilter: string

  selected: string | null
  detail: GroupDetail | null
  detailLoading: boolean

  /** Topic the lag monitor is watching; independent of the list's topic filter. */
  lagTopic: string
  lagJobId: string | null
  lagRows: LagRow[]
  totalLag: string
  lagUpdatedAt: number
  history: LagPoint[]
  lagError: string | null

  load: (clusterId: string) => Promise<void>
  setFilter: (filter: string) => void
  setTopicFilter: (topic: string) => void
  select: (clusterId: string, groupId: string | null) => Promise<void>
  refreshDetail: (clusterId: string) => Promise<void>

  setLagTopic: (topic: string) => void
  startLag: (clusterId: string) => Promise<void>
  stopLag: () => void
  watch: () => () => void
  reset: () => void
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong.'
}

export const useGroups = create<GroupState>((set, get) => ({
  groups: [],
  loading: false,
  error: null,
  filter: '',
  topicFilter: '',

  selected: null,
  detail: null,
  detailLoading: false,

  lagTopic: '',
  lagJobId: null,
  lagRows: [],
  totalLag: '0',
  lagUpdatedAt: 0,
  history: [],
  lagError: null,

  load: async (clusterId) => {
    set({ loading: true, error: null })
    try {
      const topic = get().topicFilter.trim()
      const groups = await call('groups:list', clusterId, topic || undefined)
      set({ groups, loading: false })
      // Keep a selection that still exists after a refresh.
      const { selected } = get()
      if (selected && !groups.some((g) => g.groupId === selected)) {
        set({ selected: null, detail: null })
      }
    } catch (err) {
      set({ loading: false, error: message(err), groups: [] })
    }
  },

  setFilter: (filter) => set({ filter }),
  setTopicFilter: (topicFilter) => set({ topicFilter }),

  select: async (clusterId, groupId) => {
    if (!groupId) {
      set({ selected: null, detail: null })
      return
    }
    set({ selected: groupId, detail: null, detailLoading: true, error: null })

    // A group's own topics are the only sensible default for the lag monitor.
    const summary = get().groups.find((g) => g.groupId === groupId)
    const firstTopic = summary?.topics[0]
    if (firstTopic && !get().lagJobId) set({ lagTopic: firstTopic })

    try {
      const detail = await call('groups:describe', clusterId, groupId)
      if (get().selected !== groupId) return
      set({ detail, detailLoading: false })

      // On a big cluster the list carries names only, so the group's topics
      // first become known here, from its members' assignments.
      if (!get().lagTopic && !get().lagJobId) {
        const assigned = detail.members.flatMap((m) => m.assignments.map((a) => a.topic))
        if (assigned[0]) set({ lagTopic: assigned[0] })
      }
    } catch (err) {
      if (get().selected === groupId) set({ detailLoading: false, error: message(err) })
    }
  },

  refreshDetail: async (clusterId) => {
    const { selected } = get()
    if (selected) await get().select(clusterId, selected)
  },

  setLagTopic: (lagTopic) => set({ lagTopic }),

  startLag: async (clusterId) => {
    const { selected, lagTopic, lagJobId } = get()
    if (!selected || !lagTopic.trim()) return
    if (lagJobId) await call('job:cancel', lagJobId)

    set({ lagRows: [], totalLag: '0', history: [], lagError: null, lagUpdatedAt: 0 })
    try {
      const { jobId } = await call('groups:lag:start', clusterId, selected, lagTopic.trim())
      set({ lagJobId: jobId })
    } catch (err) {
      set({ lagJobId: null, lagError: message(err) })
    }
  },

  stopLag: () => {
    const { lagJobId } = get()
    if (lagJobId) void call('job:cancel', lagJobId)
    set({ lagJobId: null })
  },

  watch: () => {
    const unsubs = [
      subscribe('lag:update', ({ jobId, rows, totalLag, ts }) => {
        if (get().lagJobId !== jobId) return
        const history = [...get().history, { ts, lag: Number(totalLag) }]
        set({
          lagRows: rows,
          totalLag,
          lagUpdatedAt: ts,
          history: history.slice(-HISTORY_POINTS)
        })
      }),

      subscribe('job:error', ({ jobId, error }) => {
        if (get().lagJobId !== jobId) return
        set({ lagJobId: null, lagError: error.message })
      }),

      subscribe('job:done', ({ jobId }) => {
        if (get().lagJobId === jobId) set({ lagJobId: null })
      })
    ]
    return () => unsubs.forEach((u) => u())
  },

  reset: () => {
    const { lagJobId } = get()
    if (lagJobId) void call('job:cancel', lagJobId)
    set({
      groups: [],
      selected: null,
      detail: null,
      error: null,
      filter: '',
      topicFilter: '',
      lagJobId: null,
      lagRows: [],
      totalLag: '0',
      history: [],
      lagError: null,
      lagUpdatedAt: 0
    })
  }
}))

/** Applies the group-id search box. */
export function visibleGroups(state: GroupState): GroupSummary[] {
  const needle = state.filter.trim().toLowerCase()
  if (!needle) return state.groups
  return state.groups.filter(
    (g) =>
      g.groupId.toLowerCase().includes(needle) ||
      g.topics.some((t) => t.toLowerCase().includes(needle))
  )
}
