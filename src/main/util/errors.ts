import type { AppError, AppErrorCode } from '@shared/models'

/**
 * The only error type that crosses IPC. Handlers throw these; the registrar
 * serializes them. Anything else is coerced to UNKNOWN with a generic message,
 * so internal stacks never reach the renderer.
 */
export class KlarityError extends Error {
  readonly code: AppErrorCode
  readonly details?: string

  constructor(code: AppErrorCode, message: string, details?: string) {
    super(message)
    this.name = 'KlarityError'
    this.code = code
    this.details = details
  }

  toAppError(): AppError {
    return { code: this.code, message: this.message, details: this.details }
  }
}

export const readOnly = (action: string): KlarityError =>
  new KlarityError(
    'READ_ONLY',
    `${action} is blocked: this cluster is registered read-only.`,
    'Turn off read-only mode in the cluster settings to allow writes.'
  )

export const notConnected = (clusterId: string): KlarityError =>
  new KlarityError('NOT_CONNECTED', 'Cluster is not connected.', `Cluster id: ${clusterId}`)

export const invalid = (message: string, details?: string): KlarityError =>
  new KlarityError('INVALID_INPUT', message, details)

/**
 * Placeholder for contract channels whose phase has not landed. Lives here
 * rather than in the IPC registrar so domain modules do not have to import
 * their own parent barrel back.
 */
export function notImplemented(channel: string): never {
  throw new KlarityError(
    'UNKNOWN',
    'This feature is not built yet.',
    `Channel ${channel} has no implementation in this build.`
  )
}

/**
 * Destructive operations require the user to type the resource name. Compared
 * in main so a renderer bug (or an unguarded code path) cannot skip the gate.
 */
export function requireConfirm(expected: string, token: string, action: string): void {
  if (token !== expected) {
    throw new KlarityError(
      'CONFIRM_MISMATCH',
      `${action} was not confirmed.`,
      `Type "${expected}" exactly to confirm.`
    )
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof KlarityError) return err.toAppError()
  if (err instanceof Error) {
    return { code: classify(err), message: err.message }
  }
  return { code: 'UNKNOWN', message: 'Unexpected error.' }
}

/** Map common kafkajs / Node failures onto codes the UI can act on. */
function classify(err: Error): AppErrorCode {
  const text = `${err.name}: ${err.message}`.toLowerCase()
  if (text.includes('sasl') || text.includes('authenticat')) return 'AUTH_FAILED'
  if (text.includes('certificate') || text.includes('self signed') || text.includes('tls'))
    return 'TLS_FAILED'
  if (text.includes('offset') && text.includes('range')) return 'OFFSET_OUT_OF_RANGE'
  if (text.includes('this topic') || text.includes('unknown topic')) return 'TOPIC_NOT_FOUND'
  if (text.includes('connect') || text.includes('broker') || text.includes('timeout'))
    return 'CONNECTION_FAILED'
  return 'UNKNOWN'
}
