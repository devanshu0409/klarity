import { contextBridge, ipcRenderer } from 'electron'
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type AsyncApi,
  type EventChannel,
  type EventMap,
  type InvokeChannel,
  type KlarityApi,
  type Unsubscribe
} from '@shared/ipc'

/**
 * The bridge is generated from the channel lists rather than hand-written, so
 * adding a channel to the contract cannot leave the renderer without it. Only
 * channels present in those lists are reachable from the renderer.
 */
const invoke = Object.fromEntries(
  INVOKE_CHANNELS.map((channel) => [
    channel,
    (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)
  ])
) as AsyncApi

const allowedEvents = new Set<string>(EVENT_CHANNELS)

function on<C extends EventChannel>(
  channel: C,
  cb: (payload: EventMap[C]) => void
): Unsubscribe {
  if (!allowedEvents.has(channel)) {
    throw new Error(`Refusing to subscribe to unknown channel: ${channel}`)
  }
  const handler = (_e: unknown, payload: EventMap[C]): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: KlarityApi = { invoke, on }

contextBridge.exposeInMainWorld('klarity', api)

// Compile-time proof that every contract channel is in the exported list.
type MissingInvoke = Exclude<InvokeChannel, (typeof INVOKE_CHANNELS)[number]>
type MissingEvent = Exclude<EventChannel, (typeof EVENT_CHANNELS)[number]>
const _invokeComplete: MissingInvoke extends never ? true : false = true
const _eventComplete: MissingEvent extends never ? true : false = true
void _invokeComplete
void _eventComplete
