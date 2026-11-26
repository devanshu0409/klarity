import { create } from 'zustand'
import type { Density, ThemePreference } from '@shared/models'
import { call } from '../lib/api'

export type Section =
  | 'clusters'
  | 'brokers'
  | 'browse'
  | 'produce'
  | 'groups'
  | 'loadtest'
  | 'settings'

interface UiState {
  section: Section
  theme: ThemePreference
  density: Density
  /** What the theme actually resolves to right now, after the system query. */
  resolvedTheme: 'light' | 'dark'
  settingsLoaded: boolean

  setSection: (section: Section) => void
  setTheme: (theme: ThemePreference) => void
  setDensity: (density: Density) => void
  /** Loads persisted settings and starts following the OS theme. */
  init: () => Promise<void>
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

function resolve(theme: ThemePreference): 'light' | 'dark' {
  if (theme === 'system') return darkQuery.matches ? 'dark' : 'light'
  return theme
}

/**
 * The DOM attributes are the source of truth for CSS: `system` clears
 * `data-theme` so the media query in tokens.css takes over, anything else
 * pins it.
 */
function applyToDom(theme: ThemePreference, density: Density): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
  root.setAttribute('data-density', density)
}

export const useUi = create<UiState>((set, get) => ({
  section: 'clusters',
  theme: 'system',
  density: 'comfortable',
  resolvedTheme: resolve('system'),
  settingsLoaded: false,

  setSection: (section) => set({ section }),

  setTheme: (theme) => {
    applyToDom(theme, get().density)
    set({ theme, resolvedTheme: resolve(theme) })
    void call('settings:set', { theme })
  },

  setDensity: (density) => {
    applyToDom(get().theme, density)
    set({ density })
    void call('settings:set', { density })
  },

  init: async () => {
    const settings = await call('settings:get')
    applyToDom(settings.theme, settings.density)
    set({
      theme: settings.theme,
      density: settings.density,
      resolvedTheme: resolve(settings.theme),
      settingsLoaded: true
    })

    darkQuery.addEventListener('change', () => {
      // Only the `system` preference tracks the OS; an explicit choice sticks.
      if (get().theme === 'system') set({ resolvedTheme: resolve('system') })
    })
  }
}))
