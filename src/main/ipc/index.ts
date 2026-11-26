import { ipcMain, type BrowserWindow } from 'electron'
import {
  INVOKE_CHANNELS,
  type EventChannel,
  type EventMap,
  type InvokeHandlers
} from '@shared/ipc'
import { toAppError } from '../util/errors'
import { logger } from '../util/log'
import { appHandlers } from './app'
import { clusterHandlers } from './clusters'
import { tabGroupHandlers } from './tabGroups'
import { brokerHandlers } from './brokers'
import { topicHandlers } from './topics'
import { consumeHandlers } from './consume'
import { serdeHandlers } from './serde'
import { produceHandlers } from './produce'
import { loadtestHandlers } from './loadtest'
import { groupHandlers } from './groups'
import { exportHandlers } from './export'

const log = logger('ipc')

/**
 * Merged handler table. Typing it as the full `InvokeHandlers` means a channel
 * added to the contract without an implementation fails typecheck here rather
 * than at runtime in front of a user.
 */
const handlers: InvokeHandlers = {
  ...appHandlers,
  ...clusterHandlers,
  ...tabGroupHandlers,
  ...brokerHandlers,
  ...topicHandlers,
  ...consumeHandlers,
  ...serdeHandlers,
  ...produceHandlers,
  ...loadtestHandlers,
  ...groupHandlers,
  ...exportHandlers
}

let mainWindow: BrowserWindow | null = null

export function registerIpc(win: BrowserWindow): void {
  mainWindow = win

  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        // The contract guarantees the arg tuple; ipcMain erases it to unknown[].
        const handler = handlers[channel] as (...a: unknown[]) => unknown
        return await handler(...args)
      } catch (err) {
        const appError = toAppError(err)
        if (appError.code === 'UNKNOWN') log.error(`${channel} failed`, err)
        else log.warn(`${channel}: ${appError.code} — ${appError.message}`)
        // Rejecting with a JSON string keeps the shape intact across IPC;
        // Electron would otherwise flatten a thrown object to its message.
        throw new Error(JSON.stringify(appError))
      }
    })
  }

  log.info(`Registered ${INVOKE_CHANNELS.length} invoke channels`)
}

export function unregisterIpc(): void {
  for (const channel of INVOKE_CHANNELS) ipcMain.removeHandler(channel)
  mainWindow = null
}

/** Push an event to the renderer. No-op after the window is gone. */
export function emit<C extends EventChannel>(channel: C, payload: EventMap[C]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channel, payload)
}
