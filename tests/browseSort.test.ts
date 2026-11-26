import { describe, expect, it } from 'vitest'
import type { DecodedMessage } from '../src/shared/models'
import { orderedMessages } from '../src/renderer/src/stores/messageStore'

const value = { format: 'json' as const, text: '{}', truncated: false, sizeBytes: 2 }

function message(partition: number, offset: string, timestamp: number): DecodedMessage {
  return { topic: 't', partition, offset, timestamp, key: value, value, headers: {}, sizeBytes: 2 }
}

/** A scan reads partitions concurrently, so arrival order is interleaved. */
const arrived = [
  message(0, '10', 1_000),
  message(1, '5', 3_000),
  message(0, '11', 2_000),
  message(2, '7', 3_000)
]

const stamps = (rows: DecodedMessage[]): number[] => rows.map((m) => m.timestamp)

describe('orderedMessages', () => {
  it('sorts newest first by timestamp, not by arrival order', () => {
    const tab = { messages: arrived, newestFirst: true } as never
    expect(stamps(orderedMessages(tab))).toEqual([3_000, 3_000, 2_000, 1_000])
  })

  it('sorts oldest first when asked', () => {
    const tab = { messages: arrived, newestFirst: false } as never
    expect(stamps(orderedMessages(tab))).toEqual([1_000, 2_000, 3_000, 3_000])
  })

  it('breaks ties on partition then offset, so equal timestamps keep log order', () => {
    const tab = { messages: arrived, newestFirst: false } as never
    const tied = orderedMessages(tab).filter((m) => m.timestamp === 3_000)
    expect(tied.map((m) => m.partition)).toEqual([1, 2])
  })

  it('compares offsets numerically past 2^53', () => {
    const big = [
      message(0, '9007199254740993', 5_000),
      message(0, '9007199254740992', 5_000)
    ]
    const tab = { messages: big, newestFirst: false } as never
    expect(orderedMessages(tab).map((m) => m.offset)).toEqual([
      '9007199254740992',
      '9007199254740993'
    ])
  })

  it('leaves the source array untouched', () => {
    const tab = { messages: arrived, newestFirst: true } as never
    orderedMessages(tab)
    expect(stamps(arrived)).toEqual([1_000, 3_000, 2_000, 3_000])
  })
})
