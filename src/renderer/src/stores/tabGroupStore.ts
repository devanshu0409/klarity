import { create } from 'zustand'
import type { TabGroup } from '@shared/models'
import { ApiError, call } from '../lib/api'

interface TabGroupState {
  groups: TabGroup[]
  loading: boolean
  error: string | null

  load: (clusterId: string) => Promise<void>
  save: (clusterId: string, name: string, topics: string[], id?: string) => Promise<TabGroup>
  remove: (id: string) => Promise<void>
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong.'
}

export const useTabGroups = create<TabGroupState>((set, get) => ({
  groups: [],
  loading: false,
  error: null,

  load: async (clusterId) => {
    set({ loading: true, error: null })
    try {
      set({ groups: await call('tabGroups:list', clusterId), loading: false })
    } catch (err) {
      set({ loading: false, error: message(err), groups: [] })
    }
  },

  save: async (clusterId, name, topics, id) => {
    const saved = await call('tabGroups:save', { id, clusterId, name, topics })
    set((s) => ({
      groups: s.groups.some((g) => g.id === saved.id)
        ? s.groups.map((g) => (g.id === saved.id ? saved : g))
        : [...s.groups, saved]
    }))
    return saved
  },

  remove: async (id) => {
    await call('tabGroups:delete', id)
    set((s) => ({ groups: s.groups.filter((g) => g.id !== id) }))
  }
}))

/** Convenience: does a same-named group already exist for this cluster (create vs overwrite). */
export function findGroupByName(groups: TabGroup[], name: string): TabGroup | null {
  const needle = name.trim().toLowerCase()
  return groups.find((g) => g.name.toLowerCase() === needle) ?? null
}
