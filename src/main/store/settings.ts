import type { AppSettings } from '@shared/models'
import { JsonFile } from './jsonFile'

interface SettingsFile extends AppSettings {
  version: 1
  window?: { width: number; height: number; x?: number; y?: number; maximized: boolean }
}

const DEFAULTS: SettingsFile = {
  version: 1,
  theme: 'system',
  density: 'comfortable',
  defaultMaxResults: 500
}

let file: JsonFile<SettingsFile> | null = null

/** Lazy so the store is only touched after `app.whenReady()` gives us userData. */
function store(): JsonFile<SettingsFile> {
  if (!file) file = new JsonFile<SettingsFile>('settings.json', DEFAULTS)
  return file
}

export function getSettings(): AppSettings {
  const { version: _v, window: _w, ...settings } = store().get()
  return settings
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  store().update((draft) => Object.assign(draft, patch))
  return getSettings()
}

export function getWindowState(): SettingsFile['window'] {
  return store().get().window
}

export function setWindowState(state: NonNullable<SettingsFile['window']>): void {
  store().update((draft) => {
    draft.window = state
  })
}
