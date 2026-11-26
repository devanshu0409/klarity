/**
 * Kafka offsets are int64 and arrive from kafkajs as decimal strings. Parsing
 * them into `number` silently loses precision past 2^53, which is reachable on
 * a long-lived high-volume partition, so all arithmetic here is on BigInt and
 * every result goes back out as a string.
 */

export function toBig(offset: string | null | undefined): bigint {
  if (offset === null || offset === undefined || offset === '') return 0n
  try {
    return BigInt(offset)
  } catch {
    return 0n
  }
}

export function subtract(a: string, b: string): string {
  const diff = toBig(a) - toBig(b)
  return (diff < 0n ? 0n : diff).toString()
}

export function add(a: string, delta: number): string {
  const sum = toBig(a) + BigInt(Math.trunc(delta))
  return (sum < 0n ? 0n : sum).toString()
}

export function sum(values: (string | null | undefined)[]): string {
  return values.reduce<bigint>((acc, v) => acc + toBig(v), 0n).toString()
}

export function compare(a: string, b: string): number {
  const [x, y] = [toBig(a), toBig(b)]
  return x < y ? -1 : x > y ? 1 : 0
}

/** Clamps to [min, max]; used before committing a hand-edited offset. */
export function clamp(value: string, min: string, max: string): string {
  const v = toBig(value)
  if (v < toBig(min)) return min
  if (v > toBig(max)) return max
  return value
}

export function isWithin(value: string, min: string, max: string): boolean {
  const v = toBig(value)
  return v >= toBig(min) && v <= toBig(max)
}
