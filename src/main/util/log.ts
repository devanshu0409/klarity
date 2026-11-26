/**
 * Minimal leveled logger. Secrets must never reach it — callers redact first;
 * `redact()` is provided for the common case of a config object.
 */

type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = LEVELS[(process.env.KLARITY_LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info

const SECRET_KEYS = /^(password|secret|token|key|clientKey|registryPassword)$/i

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${scope}: ${msg}`
  if (extra === undefined) console[level === 'debug' ? 'log' : level](line)
  else console[level === 'debug' ? 'log' : level](line, extra)
}

export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => emit('debug', scope, msg, extra),
    info: (msg: string, extra?: unknown) => emit('info', scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit('warn', scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit('error', scope, msg, extra)
  }
}

/** Deep-copy with secret-looking values replaced, for safe logging and exports. */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redact) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) && v ? '***' : redact(v)
    }
    return out as T
  }
  return value
}
