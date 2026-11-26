import type { AppError } from '@shared/models'
import type { EventChannel, EventMap, InvokeArgs, InvokeChannel, InvokeResult } from '@shared/ipc'

/**
 * Renderer-side IPC client.
 *
 * Main rejects with a JSON-encoded `AppError` (Electron would otherwise flatten
 * a thrown object down to its message string). This unwraps that back into a
 * typed error so callers can branch on `code` instead of matching text.
 */
export class ApiError extends Error {
  readonly code: AppError['code']
  readonly details?: string

  constructor(appError: AppError) {
    super(appError.message)
    this.name = 'ApiError'
    this.code = appError.code
    this.details = appError.details
  }
}

function unwrap(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  // Electron prefixes the renderer-side message with "Error invoking remote method ...:".
  const jsonStart = message.indexOf('{')
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(message.slice(jsonStart)) as AppError
      if (parsed && typeof parsed.code === 'string') throw new ApiError(parsed)
    } catch (parseErr) {
      if (parseErr instanceof ApiError) throw parseErr
    }
  }
  throw new ApiError({ code: 'UNKNOWN', message: 'Unexpected error.', details: message })
}

export async function call<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeArgs<C>
): Promise<InvokeResult<C>> {
  try {
    const fn = window.klarity.invoke[channel] as (
      ...a: InvokeArgs<C>
    ) => Promise<InvokeResult<C>>
    return await fn(...args)
  } catch (err) {
    return unwrap(err)
  }
}

export function subscribe<C extends EventChannel>(
  channel: C,
  cb: (payload: EventMap[C]) => void
): () => void {
  return window.klarity.on(channel, cb)
}
