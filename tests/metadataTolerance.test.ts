import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const { tolerateTopicMetadataErrors } = await import('../src/main/kafka/metadataTolerance')

const require = createRequire(import.meta.url)

/** Every metadata response version kafkajs ships. */
const VERSIONS = [0, 1, 2, 3, 4, 5, 6]

interface ResponseModule {
  parse: (data: unknown) => Promise<unknown>
}

const load = (version: number): ResponseModule =>
  require(`kafkajs/src/protocol/requests/metadata/v${version}/response`)

/**
 * A metadata response shaped like the one `p04` returns: the brokers are fine
 * and almost every topic is fine, but one partition is mid-leadership-election
 * (error code 5, LEADER_NOT_AVAILABLE, no leader).
 */
const responseWithElectingPartition = {
  brokers: [{ nodeId: 1, host: 'broker-1', port: 9092 }],
  clusterId: 'test-cluster',
  controllerId: 1,
  topicMetadata: [
    {
      topicErrorCode: 0,
      topic: 'healthy-topic',
      partitionMetadata: [
        { partitionErrorCode: 0, partitionId: 0, leader: 1, replicas: [1], isr: [1] }
      ]
    },
    {
      topicErrorCode: 0,
      topic: 'electing-topic',
      partitionMetadata: [
        { partitionErrorCode: 5, partitionId: 0, leader: -1, replicas: [1], isr: [] }
      ]
    }
  ]
}

describe('kafkajs metadata parsing, before the patch', () => {
  it('throws away the whole response over one leaderless partition', async () => {
    // Guards the premise: if kafkajs ever stops doing this, the patch is
    // obsolete and should be deleted rather than left monkey-patching.
    await expect(load(0).parse(responseWithElectingPartition)).rejects.toMatchObject({
      type: 'LEADER_NOT_AVAILABLE'
    })
  })
})

describe('tolerateTopicMetadataErrors', () => {
  beforeAll(() => {
    tolerateTopicMetadataErrors()
  })

  it.each(VERSIONS)('keeps the response intact on v%i', async (version) => {
    const parsed = await load(version).parse(responseWithElectingPartition)
    expect(parsed).toEqual(responseWithElectingPartition)
  })

  it('still lists the healthy topics alongside the electing one', async () => {
    const parsed = (await load(5).parse(responseWithElectingPartition)) as {
      topicMetadata: { topic: string }[]
      brokers: unknown[]
    }
    expect(parsed.topicMetadata.map((t) => t.topic)).toEqual(['healthy-topic', 'electing-topic'])
    expect(parsed.brokers).toHaveLength(1)
  })

  it('leaves the error codes in place rather than hiding them', async () => {
    const parsed = (await load(5).parse(responseWithElectingPartition)) as {
      topicMetadata: { partitionMetadata: { partitionErrorCode: number; leader: number }[] }[]
    }
    const electing = parsed.topicMetadata[1].partitionMetadata[0]
    expect(electing.partitionErrorCode).toBe(5)
    expect(electing.leader).toBe(-1)
  })

  it('is idempotent', async () => {
    tolerateTopicMetadataErrors()
    tolerateTopicMetadataErrors()
    await expect(load(0).parse(responseWithElectingPartition)).resolves.toEqual(
      responseWithElectingPartition
    )
  })
})
