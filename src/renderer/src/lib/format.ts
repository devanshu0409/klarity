/** Display helpers. Offsets stay strings; only formatting happens here. */

const groups = new Intl.NumberFormat('en-US')

/** Thousands separators for an int64-as-string, without going through Number. */
export function formatCount(value: string | number | undefined): string {
  if (value === undefined) return '—'
  const text = String(value)
  if (!/^-?\d+$/.test(text)) return text
  const negative = text.startsWith('-')
  const digits = negative ? text.slice(1) : text
  const chunked = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return negative ? `-${chunked}` : chunked
}

export function formatNumber(value: number): string {
  return groups.format(value)
}

export function formatTimestamp(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  )
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds % 60)}s`
}
