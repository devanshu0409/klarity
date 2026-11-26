import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// The store writes into Electron's userData; point it at a temp dir instead.
const dataDir = mkdtempSync(join(tmpdir(), 'klarity-test-'))
vi.mock('electron', () => ({
  app: { getPath: () => dataDir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const { retryThroughElection } = await import('../src/main/kafka/connectionPool')

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

/**
 * Shapes the way kafkajs actually throws it: `Cluster#metadata` wraps the
 * protocol error in `KafkaJSNumberOfRetriesExceeded` once its own (short)
 * retry budget is spent, with `.cause` set to the original error.
 */
function leaderNotAvailable(): Error {
  const cause = Object.assign(new Error('There is no leader for this topic-partition'), {
    type: 'LEADER_NOT_AVAILABLE',
    name: 'KafkaJSProtocolError'
  })
  return Object.assign(new Error('exceeded retries'), {
    name: 'KafkaJSNumberOfRetriesExceeded',
    cause
  })
}

describe('retryThroughElection', () => {
  it('returns the result on the first try when nothing fails', async () => {
    await expect(retryThroughElection('t', async () => 'ok')).resolves.toBe('ok')
  })

  it('retries past a leader-election error and returns once it clears', async () => {
    let calls = 0
    const result = await retryThroughElection('t', async () => {
      calls += 1
      if (calls < 3) throw leaderNotAvailable()
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  it('lets an unrelated error through immediately, with no retry', async () => {
    let calls = 0
    const boom = new Error('boom')
    await expect(
      retryThroughElection('t', async () => {
        calls += 1
        throw boom
      })
    ).rejects.toBe(boom)
    expect(calls).toBe(1)
  })

  it('gives up after the deadline with a clear message, not the raw kafka error', async () => {
    vi.useFakeTimers()
    try {
      const attempt = retryThroughElection('t', async () => {
        throw leaderNotAvailable()
      })
      // Attach the assertion before advancing time, so the rejection always
      // has a handler waiting rather than a brief unhandled-rejection window.
      const assertion = expect(attempt).rejects.toMatchObject({
        code: 'CONNECTION_FAILED',
        message: expect.stringContaining('leader election')
      })
      // Each catch schedules a bounded backoff (<=5s); this outruns the 60s deadline.
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(5_000)
      }
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('honours a shorter caller-supplied deadline', async () => {
    vi.useFakeTimers()
    try {
      const attempt = retryThroughElection(
        't',
        async () => {
          throw leaderNotAvailable()
        },
        10_000
      )
      const assertion = expect(attempt).rejects.toMatchObject({
        message: expect.stringContaining('after 10s')
      })
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(5_000)
      }
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
