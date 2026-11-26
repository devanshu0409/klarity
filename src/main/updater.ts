import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/models'
import { emit } from './ipc'
import { logger } from './util/log'

const { autoUpdater } = electronUpdater
const log = logger('updater')

let wired = false

function push(status: UpdateStatus): void {
  emit('update:status', status)
}

/**
 * electron-builder writes `app-update.yml` next to the app resources; without it
 * electron-updater cannot know what feed to ask, and every call rejects with
 * ENOENT. A locally packaged build (`npm run pack:local`) has no such file, and
 * neither would any hand-assembled copy — so treat its absence as "this build
 * does not do updates" rather than letting an error surface on every launch.
 */
function updateFeedConfigured(): boolean {
  return existsSync(join(process.resourcesPath, 'app-update.yml'))
}

/**
 * `checkForUpdates()` rejects as well as emitting `error`, so an unawaited call
 * leaves an unhandled rejection behind even though the listener already logged
 * it. Swallow it here; the listener is what the UI reacts to.
 */
function check(): void {
  autoUpdater.checkForUpdates().catch(() => undefined)
}

export function setupAutoUpdater(): void {
  // Updates only make sense for a packaged build with a feed; in dev, and in a
  // locally packaged one, the feed config is absent.
  if (!app.isPackaged || wired) return
  if (!updateFeedConfigured()) {
    log.info('No app-update.yml: this build does not check for updates')
    return
  }
  wired = true

  autoUpdater.autoDownload = false
  autoUpdater.on('checking-for-update', () => push({ state: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    push({ state: 'available', version: info.version })
  )
  autoUpdater.on('update-not-available', () => push({ state: 'idle' }))
  autoUpdater.on('download-progress', (p) =>
    push({ state: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => push({ state: 'ready', version: info.version }))
  autoUpdater.on('error', (err) => {
    log.error('Update check failed', err)
    push({ state: 'error', message: 'Could not reach the update server.' })
  })

  check()
}

export function checkForUpdates(): void {
  if (!app.isPackaged || !updateFeedConfigured()) {
    push({ state: 'idle', message: 'Updates are disabled in this build.' })
    return
  }
  check()
}

export function downloadUpdate(): void {
  if (app.isPackaged && updateFeedConfigured()) {
    autoUpdater.downloadUpdate().catch((err: unknown) => log.error('Update download failed', err))
  }
}

export function quitAndInstall(): void {
  if (app.isPackaged) autoUpdater.quitAndInstall()
}
