import { describe, expect, it } from 'vitest'
import { add, clamp, compare, isWithin, subtract, sum, toBig } from '../src/main/kafka/offsets'

/**
 * Offsets are int64. The whole point of this module is that they never pass
 * through `number`, so the tests lean on values above 2^53 where a float would
 * silently round.
 */
const BEYOND_SAFE = '9007199254740993' // 2^53 + 1

describe('offset arithmetic', () => {
  it('keeps precision past 2^53', () => {
    expect(subtract(BEYOND_SAFE, '1')).toBe('9007199254740992')
    expect(add(BEYOND_SAFE, 2)).toBe('9007199254740995')
  })

  it('never returns a negative count', () => {
    // latest < earliest can happen mid-retention-delete; a negative message
    // count in the UI would be nonsense.
    expect(subtract('5', '10')).toBe('0')
    expect(add('3', -10)).toBe('0')
  })

  it('treats missing offsets as zero', () => {
    expect(toBig(null)).toBe(0n)
    expect(toBig(undefined)).toBe(0n)
    expect(toBig('')).toBe(0n)
    expect(toBig('not-a-number')).toBe(0n)
  })

  it('sums across partitions', () => {
    expect(sum(['1', '2', null, '3'])).toBe('6')
    expect(sum([])).toBe('0')
  })

  it('compares without float conversion', () => {
    expect(compare(BEYOND_SAFE, '9007199254740992')).toBe(1)
    expect(compare('10', '10')).toBe(0)
    expect(compare('9', '10')).toBe(-1)
  })

  it('clamps into range', () => {
    expect(clamp('5', '10', '20')).toBe('10')
    expect(clamp('25', '10', '20')).toBe('20')
    expect(clamp('15', '10', '20')).toBe('15')
  })

  it('range-checks inclusively', () => {
    expect(isWithin('10', '10', '20')).toBe(true)
    expect(isWithin('20', '10', '20')).toBe(true)
    expect(isWithin('21', '10', '20')).toBe(false)
  })
})
