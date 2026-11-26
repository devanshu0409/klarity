import { describe, expect, it, vi } from 'vitest'
import type { DecodedMessage } from '../src/shared/models'
import type { SerdeConfig } from '../src/shared/serde'
import type { JobContext } from '../src/main/kafka/jobs'

const mockAdmin = {
  fetchTopicOffsets: vi.fn(),
  fetchTopicOffsetsByTimestamp: vi.fn()
}

const mockBrokers = new Map<string, { fetch: ReturnType<typeof vi.fn> }>()
let partitionLeaders: Array<{ partitionId: number; leader: number; partitionErrorCode: number }> = []

const mockCluster = {
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  addTargetTopic: vi.fn(async () => undefined),
  refreshMetadata: vi.fn(async () => undefined),
  refreshMetadataIfNecessary: vi.fn(async () => undefined),
  findTopicPartitionMetadata: vi.fn(() => partitionLeaders),
  findLeaderForPartitions: vi.fn(),
  findBroker: vi.fn(async ({ nodeId }: { nodeId: string }) => {
    const broker = mockBrokers.get(nodeId)
    if (!broker) throw Object.assign(new Error('Broker not found'), { name: 'KafkaJSBrokerNotFound' })
    return broker
  })
}

vi.mock('../src/main/kafka/connectionPool', () => ({
  adminFor: () => mockAdmin,
  fetchClusterFor: async () => mockCluster
}))

const { runSearch, peekOne, runTail } = await import('../src/main/kafka/scanner')

const utf8Serde: SerdeConfig = {
  key: { kind: 'string' },
  value: { kind: 'string' }
}

function makeCtx(): { ctx: JobContext; messages: DecodedMessage[]; stop: () => void } {
  let running = true
  const messages: DecodedMessage[] = []
  return {
    messages,
    stop: () => {
      running = false
    },
    ctx: {
      id: 'job-1',
      isRunning: () => running,
      progress: () => undefined,
      push: (m) => messages.push(m),
      flush: () => undefined
    }
  }
}

describe('direct-fetch scanner (no consumer group)', () => {
  it('runSearch fetches across multiple brokers/partitions and stops at maxResults', async () => {
    mockAdmin.fetchTopicOffsets.mockResolvedValue([
      { partition: 0, low: '0', high: '3' },
      { partition: 1, low: '10', high: '13' }
    ])
    partitionLeaders = [
      { partitionId: 0, leader: 1, partitionErrorCode: 0 },
      { partitionId: 1, leader: 2, partitionErrorCode: 0 }
    ]

    mockBrokers.clear()
    mockBrokers.set('1', {
      fetch: vi.fn(async () => ({
        responses: [
          {
            topicName: 'asset-feed',
            partitions: [
              {
                partition: 0,
                errorCode: 0,
                highWatermark: '3',
                messages: [
                  { offset: '0', timestamp: '1000', key: Buffer.from('k0'), value: Buffer.from('v0') },
                  { offset: '1', timestamp: '1001', key: Buffer.from('k1'), value: Buffer.from('v1') },
                  { offset: '2', timestamp: '1002', key: Buffer.from('k2'), value: Buffer.from('v2') }
                ]
              }
            ]
          }
        ]
      }))
    })
    mockBrokers.set('2', {
      fetch: vi.fn(async () => ({
        responses: [
          {
            topicName: 'asset-feed',
            partitions: [
              {
                partition: 1,
                errorCode: 0,
                highWatermark: '13',
                messages: [
                  { offset: '10', timestamp: '1010', key: Buffer.from('k10'), value: Buffer.from('v10') },
                  { offset: '11', timestamp: '1011', key: Buffer.from('k11'), value: Buffer.from('v11') }
                ]
              }
            ]
          }
        ]
      }))
    })

    const { ctx, messages } = makeCtx()
    const done = await runSearch(
      ctx,
      { clusterId: 'p04', topic: 'asset-feed', fromBeginning: true, maxResults: 3 },
      utf8Serde
    )

    expect(done.matched).toBe(3)
    expect(done.stoppedByGuard).toBe(true)
    expect(messages).toHaveLength(3)
  })

  it('runSearch retries when leader metadata is stale', async () => {
    mockAdmin.fetchTopicOffsets.mockResolvedValue([{ partition: 0, low: '0', high: '2' }])
    partitionLeaders = [{ partitionId: 0, leader: 1, partitionErrorCode: 0 }]

    mockBrokers.clear()
    const staleBroker = {
      fetch: vi.fn(async () => {
        partitionLeaders = [{ partitionId: 0, leader: 2, partitionErrorCode: 0 }]
        throw Object.assign(new Error('Not leader'), { type: 'NOT_LEADER_FOR_PARTITION' })
      })
    }
    const newLeaderBroker = {
      fetch: vi.fn(async () => ({
        responses: [
          {
            topicName: 'asset-feed',
            partitions: [
              {
                partition: 0,
                errorCode: 0,
                highWatermark: '2',
                messages: [
                  { offset: '0', timestamp: '1000', key: null, value: Buffer.from('hello') },
                  { offset: '1', timestamp: '1001', key: null, value: Buffer.from('world') }
                ]
              }
            ]
          }
        ]
      }))
    }
    mockBrokers.set('1', staleBroker)
    mockBrokers.set('2', newLeaderBroker)

    const { ctx, messages } = makeCtx()
    const done = await runSearch(
      ctx,
      { clusterId: 'p04', topic: 'asset-feed', fromBeginning: true, maxResults: 50 },
      utf8Serde
    )

    expect(done.matched).toBe(2)
    expect(messages.map((m) => m.value.text)).toEqual(['hello', 'world'])
  })

  it('peekOne fetches a single offset directly', async () => {
    mockAdmin.fetchTopicOffsets.mockResolvedValue([{ partition: 56, low: '100', high: '105' }])
    partitionLeaders = [{ partitionId: 56, leader: 1, partitionErrorCode: 0 }]

    mockBrokers.clear()
    mockBrokers.set('1', {
      fetch: vi.fn(async () => ({
        responses: [
          {
            topicName: 'asset-feed',
            partitions: [
              {
                partition: 56,
                errorCode: 0,
                highWatermark: '105',
                messages: [
                  { offset: '104', timestamp: '2000', key: Buffer.from('k'), value: Buffer.from('latest') }
                ]
              }
            ]
          }
        ]
      }))
    })

    const msg = await peekOne({ clusterId: 'p04', topic: 'asset-feed', partition: 56 }, utf8Serde)
    expect(msg?.offset).toBe('104')
    expect(msg?.value.text).toBe('latest')
  })

  it('runTail polls new messages and stops when cancelled', async () => {
    mockAdmin.fetchTopicOffsets.mockResolvedValue([{ partition: 0, low: '0', high: '5' }])
    partitionLeaders = [{ partitionId: 0, leader: 1, partitionErrorCode: 0 }]

    const { ctx, messages, stop } = makeCtx()
    mockBrokers.clear()
    let calls = 0
    mockBrokers.set('1', {
      fetch: vi.fn(async () => {
        calls++
        if (calls > 1) {
          stop()
          return { responses: [] }
        }
        return {
          responses: [
            {
              topicName: 'asset-feed',
              partitions: [
                {
                  partition: 0,
                  errorCode: 0,
                  highWatermark: '6',
                  messages: [
                    { offset: '5', timestamp: '3000', key: null, value: Buffer.from('live-msg') }
                  ]
                }
              ]
            }
          ]
        }
      })
    })

    const done = await runTail(ctx, { clusterId: 'p04', topic: 'asset-feed' }, utf8Serde)
    expect(done.matched).toBe(1)
    expect(messages[0]?.value.text).toBe('live-msg')
  })
})
