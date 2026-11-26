import { create } from 'zustand'
import type { ClusterHealth, ClusterProfile, ClusterProfileInput } from '@shared/models'
import { ApiError, call, subscribe } from '../lib/api'

interface ClusterState {
  profiles: ClusterProfile[]
  /** Which cluster every other view acts on. Null until one is chosen. */
  selectedId: string | null
  health: Record<string, ClusterHealth>
  loading: boolean
  error: string | null

  load: () => Promise<void>
  select: (id: string | null) => void
  save: (input: ClusterProfileInput) => Promise<ClusterProfile>
  clone: (id: string) => Promise<ClusterProfile>
  remove: (id: string) => Promise<void>
  connect: (id: string) => Promise<void>
  disconnect: (id: string) => Promise<void>
  /** Starts the cluster:status subscription. Safe to call once at startup. */
  watch: () => () => void
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong.'
}

export const useClusters = create<ClusterState>((set, get) => ({
  profiles: [],
  selectedId: null,
  health: {},
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null })
    try {
      const profiles = await call('clusters:list')
      set({ profiles, loading: false })
      // Keep a selection pointing at something that still exists.
      const { selectedId } = get()
      if (selectedId && !profiles.some((p) => p.id === selectedId)) set({ selectedId: null })
      if (!get().selectedId && profiles.length === 1) set({ selectedId: profiles[0].id })
    } catch (err) {
      set({ loading: false, error: message(err) })
    }
  },

  select: (id) => set({ selectedId: id }),

  save: async (input) => {
    const saved = await call('clusters:save', input)
    await get().load()
    set({ selectedId: saved.id })
    return saved
  },

  clone: async (id) => {
    const cloned = await call('clusters:clone', id)
    await get().load()
    set({ selectedId: cloned.id })
    return cloned
  },

  remove: async (id) => {
    await call('clusters:delete', id)
    set((s) => {
      const { [id]: _dropped, ...health } = s.health
      return { health, selectedId: s.selectedId === id ? null : s.selectedId }
    })
    await get().load()
  },

  connect: async (id) => {
    set((s) => ({
      health: {
        ...s.health,
        [id]: { ...(s.health[id] ?? blankHealth(id)), state: 'connecting' }
      },
      error: null
    }))
    try {
      const health = await call('clusters:connect', id)
      set((s) => ({ health: { ...s.health, [id]: health }, selectedId: id }))
    } catch (err) {
      set((s) => ({
        health: {
          ...s.health,
          [id]: { ...blankHealth(id), state: 'disconnected', error: message(err) }
        },
        error: message(err)
      }))
      throw err
    }
  },

  disconnect: async (id) => {
    await call('clusters:disconnect', id)
    set((s) => ({ health: { ...s.health, [id]: blankHealth(id) } }))
  },

  watch: () =>
    subscribe('cluster:status', (health) => {
      set((s) => ({ health: { ...s.health, [health.clusterId]: health } }))
    })
}))

function blankHealth(clusterId: string): ClusterHealth {
  return {
    clusterId,
    state: 'disconnected',
    brokerCount: 0,
    topicCount: 0,
    latencyMs: 0,
    checkedAt: Date.now()
  }
}

/** Convenience selectors used across views. */
export function useSelectedCluster(): ClusterProfile | null {
  return useClusters((s) => s.profiles.find((p) => p.id === s.selectedId) ?? null)
}

export function useIsConnected(): boolean {
  return useClusters((s) => (s.selectedId ? s.health[s.selectedId]?.state === 'connected' : false))
}
