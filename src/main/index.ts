import { app, BrowserWindow, nativeTheme, screen, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { registerIpc, unregisterIpc } from './ipc'
import { disconnectAll } from './kafka/connectionPool'
import { registerCompressionCodecs } from './kafka/compression'
import { tolerateTopicMetadataErrors } from './kafka/metadataTolerance'
import { getSettings, getWindowState, setWindowState } from './store/settings'
import { setupAutoUpdater } from './updater'
import { logger } from './util/log'

const log = logger('main')
const isDev = !!process.env.ELECTRON_RENDERER_URL

// GPU compositing can silently fail on locked-down/virtualized Windows setups
// (corporate VDI, no passthrough GPU): the window is created, reports the
// right size and "visible" to the OS, and never paints a pixel — indistinguishable
// from "nothing happens" when the user clicks it. Software rendering is slower
// but always actually shows something; call this before any other app API, per
// Electron's own guidance.
app.disableHardwareAcceleration()

// A second instance would fight over the same settings file and duplicate every
// Kafka connection; focus the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

function backgroundFor(): string {
  const theme = getSettings().theme
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors)
  // Must match --bg-app in tokens.css, or the window flashes the wrong shade
  // before the renderer paints.
  return dark ? '#131314' : '#f3f0ee'
}

/**
 * `build/icon.*` sits two levels up from `out/main` in the repo and in a locally
 * packaged app alike. Returns undefined when the file is missing so Electron is
 * never handed a path that does not exist.
 */
function resolveWindowIcon(): string | undefined {
  const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  const candidate = join(__dirname, '../../build', file)
  return existsSync(candidate) ? candidate : undefined
}

const windowIcon = resolveWindowIcon()

/**
 * A saved position from a monitor setup that no longer exists (disconnected
 * external display, different remote-session resolution) would otherwise
 * place the window fully off-screen: the process runs and the taskbar shows
 * it, but nothing is ever visible to click into. Require a real sliver of the
 * title bar to land on some display, not just a coordinate that is technically
 * non-negative.
 */
function isOnScreen(x: number, y: number, width: number, height: number): boolean {
  const margin = 40
  return screen.getAllDisplays().some((d) => {
    const { x: dx, y: dy, width: dw, height: dh } = d.workArea
    return x < dx + dw && x + width > dx + margin && y < dy + dh && y + height > dy + margin
  })
}

function createWindow(): BrowserWindow {
  const saved = getWindowState()
  // Clamp to the work area: an unclamped default (or a size saved on a larger
  // monitor) opens with the status bar hanging below the taskbar.
  const { width: availW, height: availH } = screen.getPrimaryDisplay().workAreaSize

  const width = Math.min(saved?.width ?? 1360, availW)
  const height = Math.min(saved?.height ?? 860, availH)
  const savedX = saved?.x
  const savedY = saved?.y
  const onScreen = savedX !== undefined && savedY !== undefined && isOnScreen(savedX, savedY, width, height)

  const win = new BrowserWindow({
    width,
    height,
    x: onScreen ? savedX : undefined,
    y: onScreen ? savedY : undefined,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: backgroundFor(),
    // An electron-builder installer embeds the icon in the executable, so the
    // window inherits it. A locally packaged build (`npm run pack:local`) has no
    // rcedit step, so the file has to be pointed at explicitly — same path in
    // both layouts, and skipped when it is genuinely absent.
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      // `.mjs`: the package is ESM, so electron-vite emits an ESM preload. It
      // loads only with sandbox disabled, which is why that stays false here.
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Maximizing before the first paint is a known Electron/Windows trap: the OS
  // registers the window (taskbar entry, "the app is open") but it never
  // actually renders, so clicking that entry brings up nothing. Show first,
  // maximize after.
  win.on('ready-to-show', () => {
    win.show()
    if (saved?.maximized) win.maximize()
  })

  const persistBounds = (): void => {
    const { width, height, x, y } = win.getNormalBounds()
    setWindowState({ width, height, x, y, maximized: win.isMaximized() })
  }
  win.on('resize', persistBounds)
  win.on('move', persistBounds)
  win.on('close', persistBounds)

  // External links open in the OS browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    // Surface renderer errors in the terminal; otherwise a crashed render tree
    // is just a blank window with the details hidden in DevTools.
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 'warning') {
        log.warn(`renderer: ${event.message} (${event.sourceId}:${event.lineNumber})`)
      }
    })
    win.webContents.on('render-process-gone', (_e, details) =>
      log.error(`renderer process gone: ${details.reason}`)
    )
    void win.loadURL(process.env.ELECTRON_RENDERER_URL as string)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  registerCompressionCodecs()
  tolerateTopicMetadataErrors()
  const win = createWindow()
  registerIpc(win)
  setupAutoUpdater()

  app.on('second-instance', () => {
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const next = createWindow()
      unregisterIpc()
      registerIpc(next)
    }
  })

  log.info(`Klarity ${app.getVersion()} ready`)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Close broker sockets on the way out; kafkajs keeps them alive otherwise and
// the process lingers.
app.on('before-quit', (event) => {
  if (shuttingDown) return
  shuttingDown = true
  event.preventDefault()
  void disconnectAll()
    .catch((err: unknown) => log.warn('Disconnect during shutdown failed', err))
    .finally(() => app.quit())
})

let shuttingDown = false
