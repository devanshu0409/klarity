import { create } from 'zustand'
import type { TopicDetail, TopicSummary } from '@shared/models'
import { ApiError, call } from '../lib/api'

interface TopicState {
  topics: TopicSummary[]
  detail: TopicDetail | null
  selected: string | null
  loading: boolean
  detailLoading: boolean
  error: string | null
  filter: string
  showInternal: boolean

  load: (clusterId: string, refresh?: boolean) => Promise<void>
  open: (clusterId: string, topic: string) => Promise<void>
  close: () => void
  setFilter: (filter: string) => void
  setShowInternal: (show: boolean) => void
  reset: () => void
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong.'
}

export const useTopics = create<TopicState>((set, get) => ({
  topics: [],
  detail: null,
  selected: null,
  loading: false,
  detailLoading: false,
  error: null,
  filter: '',
  // Internal topics (__consumer_offsets and friends) are noise until asked for.
  showInternal: false,

  load: async (clusterId, refresh) => {
    set({ loading: true, error: null })
    try {
      set({ topics: await call('topics:list', clusterId, refresh), loading: false })
    } catch (err) {
      set({ loading: false, error: message(err), topics: [] })
    }
  },

  open: async (clusterId, topic) => {
    set({ selected: topic, detailLoading: true, detail: null, error: null })
    try {
      const detail = await call('topics:describe', clusterId, topic)
      // A slower earlier request must not overwrite a newer selection.
      if (get().selected === topic) set({ detail, detailLoading: false })
    } catch (err) {
      if (get().selected === topic) set({ detailLoading: false, error: message(err) })
    }
  },

  close: () => set({ selected: null, detail: null }),
  setFilter: (filter) => set({ filter }),
  setShowInternal: (showInternal) => set({ showInternal }),
  reset: () => set({ topics: [], detail: null, selected: null, error: null, filter: '' })
}))

/** Applies the search box and the internal-topic toggle. */
export function visibleTopics(state: TopicState): TopicSummary[] {
  const needle = state.filter.trim().toLowerCase()
  return state.topics.filter((t) => {
    if (!state.showInternal && t.isInternal) return false
    return needle === '' || t.name.toLowerCase().includes(needle)
  })
}
