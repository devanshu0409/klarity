import { describe, expect, it } from 'vitest'
import { nextOffset, type PartitionContext } from '../src/main/kafka/groups'
import { clamp, isWithin } from '../src/main/kafka/offsets'

/** A partition retaining [1000, 2000) with the group sitting at 1500. */
const ctx: PartitionContext = {
  partition: 3,
  earliest: '1000',
  latest: '2000',
  current: '1500'
}

describe('nextOffset', () => {
  it('moves to the ends of the retained log', () => {
    expect(nextOffset({ kind: 'earliest' }, ctx)).toBe('1000')
    expect(nextOffset({ kind: 'latest' }, ctx)).toBe('2000')
  })

  it('shifts from the committed offset in both directions', () => {
    expect(nextOffset({ kind: 'shift-by', delta: -100 }, ctx)).toBe('1400')
    expect(nextOffset({ kind: 'shift-by', delta: 250 }, ctx)).toBe('1750')
  })

  it('shifts from the earliest offset when the group never committed', () => {
    const fresh = { ...ctx, current: null }
    expect(nextOffset({ kind: 'shift-by', delta: 50 }, fresh)).toBe('1050')
  })

  it('takes the timestamp lookup, falling back to the end when nothing is newer', () => {
    expect(nextOffset({ kind: 'to-datetime', timestampMs: 1 }, { ...ctx, atTimestamp: '1720' })).toBe(
      '1720'
    )
    // Kafka answers -1 when every record predates the timestamp.
    expect(nextOffset({ kind: 'to-datetime', timestampMs: 1 }, { ...ctx, atTimestamp: '-1' })).toBe(
      '2000'
    )
    expect(nextOffset({ kind: 'to-datetime', timestampMs: 1 }, ctx)).toBe('2000')
  })

  it('uses a hand-edited offset, leaving unedited partitions where they are', () => {
    expect(nextOffset({ kind: 'explicit', offsets: { 3: '1234' } }, ctx)).toBe('1234')
    expect(nextOffset({ kind: 'explicit', offsets: { 7: '1234' } }, ctx)).toBe('1500')
  })

  it('flags an out-of-range shift, which apply then clamps', () => {
    const beyond = nextOffset({ kind: 'shift-by', delta: 9_000 }, ctx)
    expect(beyond).toBe('10500')
    expect(isWithin(beyond, ctx.earliest, ctx.latest)).toBe(false)
    expect(clamp(beyond, ctx.earliest, ctx.latest)).toBe('2000')
  })

  it('keeps int64 offsets exact past 2^53', () => {
    const big = { ...ctx, earliest: '9007199254740990', latest: '9007199254740999', current: '9007199254740993' }
    expect(nextOffset({ kind: 'shift-by', delta: 2 }, big)).toBe('9007199254740995')
  })
})
