import kafkajs, { type Admin } from 'kafkajs'
import type {
  BrokerInfo,
  ConfigEntry,
  PartitionDetail,
  TopicDetail,
  TopicSpec,
  TopicSummary
} from '@shared/models'
import { KlarityError, invalid } from '../util/errors'
import {
  adminFor,
  assertWritable,
  invalidateTopicMetadata,
  retryThroughElection,
  topicMetadata
} from './connectionPool'
import { compare, subtract, sum } from './offsets'

// kafkajs is CommonJS: Node's ESM loader only exposes the named exports its
// lexer can detect, and `ConfigResourceTypes` is not one of them. Pull values
// off the default export instead.
const { ConfigResourceTypes } = kafkajs

/** kafkajs returns `-1` for "no leader"; surface that as-is rather than hiding it. */
const NO_LEADER = -1

// ---------------------------------------------------------------------------
// Brokers
// ---------------------------------------------------------------------------

export async function listBrokers(clusterId: string): Promise<BrokerInfo[]> {
  const admin = adminFor(clusterId)
  // Same tolerance as connect: one leaderless partition anywhere on the
  // cluster must not block a broker list nobody asked about that topic for.
  const cluster = await retryThroughElection('describeCluster', () => admin.describeCluster())

  // Leader counts come from topic metadata — the same cached snapshot the topic
  // list uses, so opening Brokers does not repeat a multi-second fetch.
  const leaderCounts = new Map<number, number>()
  try {
    const topics = await topicMetadata(clusterId)
    for (const topic of topics) {
      for (const partition of topic.partitions) {
        if (partition.leader === NO_LEADER) continue
        leaderCounts.set(partition.leader, (leaderCounts.get(partition.leader) ?? 0) + 1)
      }
    }
  } catch {
    // Metadata can be denied by ACLs; the broker list itself is still useful.
  }

  return cluster.brokers
    .map((b) => ({
      nodeId: b.nodeId,
      host: b.host,
      port: b.port,
      isController: cluster.controller === b.nodeId,
      leaderPartitionCount: leaderCounts.get(b.nodeId)
    }))
    .sort((a, b) => a.nodeId - b.nodeId)
}

export async function describeBrokerConfigs(
  clusterId: string,
  brokerId: number
): Promise<ConfigEntry[]> {
  const admin = adminFor(clusterId)
  const result = await admin.describeConfigs({
    includeSynonyms: false,
    resources: [{ type: ConfigResourceTypes.BROKER, name: String(brokerId) }]
  })
  return mapConfigEntries(result.resources[0]?.configEntries)
}

interface RawConfigEntry {
  configName: string
  configValue: string
  isDefault: boolean
  isSensitive: boolean
  readOnly: boolean
  configSource?: string | number
}

function mapConfigEntries(entries: RawConfigEntry[] | undefined): ConfigEntry[] {
  if (!entries) return []
  return entries
    .map((e) => ({
      name: e.configName,
      // Sensitive values come back empty from Kafka; say so rather than
      // rendering a blank cell that looks like an unset config.
      value: e.isSensitive ? '(hidden)' : e.configValue,
      isDefault: e.isDefault,
      isSensitive: e.isSensitive,
      isReadOnly: e.readOnly,
      source: e.configSource !== undefined ? String(e.configSource) : undefined
    }))
    .sort((a, b) => {
      // Explicitly-set values first: those are what someone came to look at.
      if (a.isDefault !== b.isDefault) return a.isDefault ? 1 : -1
      return a.name.localeCompare(b.name)
    })
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

/**
 * Topic list from cluster metadata only — one round trip for the whole cluster.
 *
 * Message counts are deliberately absent here: they need `fetchTopicOffsets`
 * per topic, which on a real cluster (1800+ topics is normal) means thousands
 * of extra requests and a list that takes minutes to appear. Counts are
 * computed in `describeTopic`, for the one topic the user actually opened.
 */
export async function listTopics(clusterId: string, refresh = false): Promise<TopicSummary[]> {
  // Served from the snapshot taken during connect unless the user asked for a
  // refresh; the fetch itself is ~5.5s on a cluster this size.
  const topics = await topicMetadata(clusterId, refresh)

  return topics
    .map((topic) => ({
      name: topic.name,
      partitionCount: topic.partitions.length,
      replicationFactor: topic.partitions[0]?.replicas.length ?? 0,
      isInternal: topic.name.startsWith('__'),
      underReplicated: topic.partitions.some(
        (p) => p.isr.length < p.replicas.length || p.leader === NO_LEADER
      )
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function describeTopic(clusterId: string, topic: string): Promise<TopicDetail> {
  const admin = adminFor(clusterId)

  const metadata = await admin.fetchTopicMetadata({ topics: [topic] })
  const meta = metadata.topics[0]
  // Metadata parsing tolerates per-topic errors now (see `metadataTolerance.ts`),
  // so a topic that does not exist comes back present-but-empty instead of
  // throwing. No partitions means no topic, either way.
  if (!meta || meta.partitions.length === 0) {
    throw new KlarityError('TOPIC_NOT_FOUND', `Topic "${topic}" was not found.`)
  }

  const offsets = await admin.fetchTopicOffsets(topic)
  const offsetByPartition = new Map(offsets.map((o) => [o.partition, o]))

  const partitions: PartitionDetail[] = meta.partitions
    .map((p) => {
      const o = offsetByPartition.get(p.partitionId)
      const earliest = o?.low ?? '0'
      const latest = o?.high ?? '0'
      return {
        partition: p.partitionId,
        leader: p.leader,
        replicas: p.replicas,
        isr: p.isr,
        earliestOffset: earliest,
        latestOffset: latest,
        messageCount: subtract(latest, earliest)
      }
    })
    .sort((a, b) => a.partition - b.partition)

  const configs = await admin
    .describeConfigs({
      includeSynonyms: false,
      resources: [{ type: ConfigResourceTypes.TOPIC, name: topic }]
    })
    .then((r) => mapConfigEntries(r.resources[0]?.configEntries))
    .catch(() => [] as ConfigEntry[])

  return {
    name: topic,
    isInternal: topic.startsWith('__'),
    partitions,
    configs,
    totalMessageCount: sum(partitions.map((p) => p.messageCount)),
    underReplicatedCount: partitions.filter(
      (p) => p.isr.length < p.replicas.length || p.leader === NO_LEADER
    ).length
  }
}

export async function createTopic(clusterId: string, spec: TopicSpec): Promise<void> {
  assertWritable(clusterId, 'Creating a topic')

  if (!spec.name.trim()) throw invalid('Topic name is required.')
  // Kafka's own rule; catching it here gives a better message than the broker's.
  if (!/^[a-zA-Z0-9._-]+$/.test(spec.name)) {
    throw invalid(
      'Topic names may only contain letters, digits, dot, underscore and hyphen.',
      `Received: ${spec.name}`
    )
  }
  if (spec.numPartitions < 1) throw invalid('A topic needs at least one partition.')
  if (spec.replicationFactor < 1) throw invalid('Replication factor must be at least 1.')

  const admin = adminFor(clusterId)
  const created = await admin.createTopics({
    waitForLeaders: true,
    topics: [
      {
        topic: spec.name,
        numPartitions: spec.numPartitions,
        replicationFactor: spec.replicationFactor,
        configEntries: Object.entries(spec.configs).map(([name, value]) => ({ name, value }))
      }
    ]
  })

  // kafkajs resolves false when the topic already exists rather than throwing.
  if (!created) {
    throw invalid(`Topic "${spec.name}" already exists.`)
  }

  invalidateTopicMetadata(clusterId)
}

export async function updateTopicConfig(
  clusterId: string,
  topic: string,
  configs: Record<string, string>
): Promise<void> {
  assertWritable(clusterId, 'Updating topic configuration')
  const entries = Object.entries(configs)
  if (entries.length === 0) throw invalid('No configuration entries to apply.')

  const admin = adminFor(clusterId)
  await admin.alterConfigs({
    validateOnly: false,
    resources: [
      {
        type: ConfigResourceTypes.TOPIC,
        name: topic,
        configEntries: entries.map(([name, value]) => ({ name, value }))
      }
    ]
  })
}

export async function addPartitions(
  clusterId: string,
  topic: string,
  newTotal: number
): Promise<void> {
  assertWritable(clusterId, 'Adding partitions')

  const detail = await describeTopic(clusterId, topic)
  const current = detail.partitions.length
  if (newTotal <= current) {
    throw invalid(
      `Topic "${topic}" already has ${current} partitions.`,
      'Partition count can only be increased; Kafka cannot remove partitions.'
    )
  }

  const admin = adminFor(clusterId)
  await admin.createPartitions({
    validateOnly: false,
    topicPartitions: [{ topic, count: newTotal }]
  })
  invalidateTopicMetadata(clusterId)
}

export async function deleteTopic(clusterId: string, topic: string): Promise<void> {
  assertWritable(clusterId, 'Deleting a topic')
  const admin = adminFor(clusterId)
  await admin.deleteTopics({ topics: [topic] })
  invalidateTopicMetadata(clusterId)
}

// ---------------------------------------------------------------------------
// Shared helper for later phases
// ---------------------------------------------------------------------------

/** Earliest/latest per partition, as a map. Used by the scanner and lag views. */
export async function fetchOffsetBounds(
  admin: Admin,
  topic: string
): Promise<Map<number, { earliest: string; latest: string }>> {
  const offsets = await admin.fetchTopicOffsets(topic)
  return new Map(offsets.map((o) => [o.partition, { earliest: o.low, latest: o.high }]))
}

/** True when the partition holds no records. */
export function isEmptyPartition(earliest: string, latest: string): boolean {
  return compare(earliest, latest) === 0
}
