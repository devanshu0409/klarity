import { describe, expect, it } from 'vitest'
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '../src/shared/ipc'

/**
 * The preload bridge is built from these lists, so a channel added to the
 * contract types but forgotten here would be invisible to the renderer at
 * runtime while still typechecking. Types cannot catch duplicates or drift in
 * the array itself, so assert on it directly.
 */
describe('IPC channel lists', () => {
  it('has no duplicate invoke channels', () => {
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length)
  })

  it('has no duplicate event channels', () => {
    expect(new Set(EVENT_CHANNELS).size).toBe(EVENT_CHANNELS.length)
  })

  it('namespaces every channel as domain:action', () => {
    for (const channel of [...INVOKE_CHANNELS, ...EVENT_CHANNELS]) {
      expect(channel, `${channel} should contain a colon`).toContain(':')
    }
  })

  it('keeps destructive operations out of the event channels', () => {
    // Events are fire-and-forget into the renderer; nothing that mutates a
    // cluster should ever be reachable that way.
    const mutating = EVENT_CHANNELS.filter((c) =>
      /delete|reset|create|produce|addPartitions/i.test(c)
    )
    expect(mutating).toEqual([])
  })
})
