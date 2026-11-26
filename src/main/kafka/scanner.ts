import { createRequire } from 'node:module'
import type {
  DecodedMessage,
  JobDone,
  PeekRequest,
  SearchRequest,
  TailRequest
} from '@shared/models'
import type { SerdeConfig } from '@shared/serde'
import { KlarityError } from '../util/errors'
import { logger } from '../util/log'
import { decodeBatch, decodeHeaders, decodeOne } from '../serde/decode'
import { compileFilter } from '../serde/filter'
import {
  adminFor,
  fetchClusterFor,
  type KafkaFetchCluster,
  type KafkaFetchMessage,
  type KafkaFetchPartitionResponse
} from './connectionPool'
import { compare, subtract, toBig } from './offsets'
import type { JobContext } from './jobs'

const log = logger('scanner')
const require = createRequire(import.meta.url)

const Batch = require('kafkajs/src/consumer/batch') as new (
  topic: string,
  fetchedOffset: string,
  partitionData: KafkaFetchPartitionResponse
) => {
  messages: KafkaFetchMessage[]
  messagesWithinOffset: KafkaFetchMessage[]
  isEmptyDueToLogCompactedMessages: () => boolean
}
const ISOLATION_LEVEL = require('kafkajs/src/protocol/isolationLevel') as {
  READ_COMMITTED: number
}

/**
 * How far back a tail scan reaches when no time range is given. A filtered
 * search needs a wider window to have a chance of matching; an unfiltered one
 * only needs enough records to fill the result cap.
 */
const FILTERED_WINDOW = 1000n

const MAX_BYTES_PER_PARTITION = 1_048_576
const MAX_BYTES_RESPONSE = 10_485_760
const SEARCH_MAX_WAIT_MS = 250
const TAIL_MAX_WAIT_MS = 1_000
const MAX_STALE_METADATA_RETRIES = 5
const MAX_EMPTY_FETCHES = 5

const STALE_METADATA_TYPES = new Set([
  'LEADER_NOT_AVAILABLE',
  'NOT_LEADER_FOR_PARTITION',
  'FENCED_LEADER_EPOCH',
  'UNKNOWN_LEADER_EPOCH',
  'UNKNOWN_TOPIC_OR_PARTITION'
])

function isStaleMetadataError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const type = (err as Error & { type?: string }).type
  return (
    err.name === 'KafkaJSBrokerNotFound' ||
    err.name === 'KafkaJSTopicMetadataNotLoaded' ||
    (type !== undefined && STALE_METADATA_TYPES.has(type))
  )
}

function isOffsetOutOfRange(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const type = (err as Error & { type?: string }).type
  return err.name === 'KafkaJSOffsetOutOfRange' || type === 'OFFSET_OUT_OF_RANGE'
}

async function resolveLeaders(
  cluster: KafkaFetchCluster,
  topic: string,
  partitions: number[]
): Promise<Map<string, number[]>> {
  await cluster.addTargetTopic(topic)
  await cluster.refreshMetadataIfNecessary()

  let meta = cluster.findTopicPartitionMetadata(topic)
  const missingLeader = partitions.some((p) => {
    const m = meta.find((entry) => entry.partitionId === p)
    return !m || m.leader == null || m.leader < 0
  })
  if (missingLeader) {
    await cluster.refreshMetadata()
    meta = cluster.findTopicPartitionMetadata(topic)
  }

  const byLeader = new Map<string, number[]>()
  for (const p of partitions) {
    const m = meta.find((entry) => entry.partitionId === p)
    if (!m || m.leader == null || m.leader < 0) {
      log.warn(`No leader for ${topic}[${p}], skipping`)
      continue
    }
    const key = String(m.leader)
    const list = byLeader.get(key)
    if (list) list.push(p)
    else byLeader.set(key, [p])
  }

  if (byLeader.size === 0 && partitions.length > 0) {
    throw new KlarityError(
      'CONNECTION_FAILED',
      `No partition leaders are available for "${topic}".`,
      'The topic may be undergoing leader election — try again shortly.'
    )
  }

  return byLeader
}

interface PartitionPlan {
  partition: number
  start: string
  /** Exclusive: the high watermark when the scan began. */
  end: string
}

interface Bounds {
  partition: number
  low: string
  high: string
}

async function fetchBounds(clusterId: string, topic: string): Promise<Bounds[]> {
  const admin = adminFor(clusterId)
  const offsets = await admin.fetchTopicOffsets(topic)
  if (offsets.length === 0) {
    throw new KlarityError('TOPIC_NOT_FOUND', `Topic "${topic}" has no partitions.`)
  }
  return offsets.map((o) => ({ partition: o.partition, low: o.low, high: o.high }))
}

/**
 * Turns a search request into a per-partition offset range, mirroring the
 * strategy the Java tool proved out:
 *
 *   from beginning        -> earliest .. high
 *   time range            -> offsetsForTimes(from) .. high
 *   explicit offset       -> that offset .. high   (single partition only)
 *   default (tail scan)   -> high - window .. high
 *
 * The default is what makes "what just happened" cheap on a topic with a
 * hundred million records.
 */
async function planSearch(req: SearchRequest): Promise<PartitionPlan[]> {
  const bounds = await fetchBounds(req.clusterId, req.topic)
  const selected =
    req.partition === undefined ? bounds : bounds.filter((b) => b.partition === req.partition)

  if (selected.length === 0) {
    throw new KlarityError(
      'INVALID_INPUT',
      `Partition ${req.partition} does not exist on "${req.topic}".`
    )
  }

  let timeStarts: Map<number, string> | undefined
  if (req.timeRange?.fromMs) {
    const admin = adminFor(req.clusterId)
    const byTime = await admin.fetchTopicOffsetsByTimestamp(req.topic, req.timeRange.fromMs)
    timeStarts = new Map(byTime.map((o) => [o.partition, o.offset]))
  }

  const hasFilter = !!req.filter?.trim()
  const window = hasFilter
    ? FILTERED_WINDOW
    : BigInt(Math.max(req.maxResults, 1))

  return selected
    .map((b): PartitionPlan => {
      let start: string
      if (req.fromBeginning) {
        start = b.low
      } else if (timeStarts) {
        // -1 means "no offset at or after that timestamp" — nothing to read.
        const found = timeStarts.get(b.partition)
        start = !found || found === '-1' ? b.high : found
      } else if (req.startOffset && req.partition !== undefined) {
        start = req.startOffset
      } else {
        const from = toBig(b.high) - window
        start = from > toBig(b.low) ? from.toString() : b.low
      }
      return { partition: b.partition, start, end: b.high }
    })
    .filter((p) => compare(p.start, p.end) < 0)
}

/** Runs direct broker fetches over a bounded plan, pushing decoded matches into the job. */
async function runPlan(
  ctx: JobContext,
  clusterId: string,
  topic: string,
  plan: PartitionPlan[],
  serde: SerdeConfig,
  options: {
    filter?: string
    maxResults: number
  }
): Promise<Omit<JobDone, 'jobId' | 'elapsedMs'>> {
  const matcher = compileFilter(options.filter)
  const partitionOffsets: Record<number, string> = {}

  let scanned = 0
  let matched = 0
  let stoppedByGuard = false

  const totalToScan = plan.reduce((acc, p) => acc + toBig(subtract(p.end, p.start)), 0n)
  const state = new Map(plan.map((p) => [p.partition, { nextOffset: p.start, end: p.end }]))

  if (plan.length === 0) {
    return { scanned: 0, matched: 0, partitionOffsets }
  }

  const cluster = await fetchClusterFor(clusterId)
  let metadataRetries = 0

  while (ctx.isRunning() && !stoppedByGuard && state.size > 0) {
    const byLeader = await resolveLeaders(cluster, topic, [...state.keys()])
    if (byLeader.size === 0) break

    let needsRebalance = false

    await Promise.all(
      [...byLeader.entries()].map(async ([nodeId, initialPartitions]) => {
        let localPartitions = initialPartitions.filter((p) => state.has(p))
        let emptyFetches = 0

        let broker
        try {
          broker = await cluster.findBroker({ nodeId })
        } catch (err) {
          if (isStaleMetadataError(err)) {
            needsRebalance = true
            return
          }
          throw err
        }

        while (ctx.isRunning() && !stoppedByGuard && localPartitions.length > 0 && !needsRebalance) {
          let responses
          try {
            const res = await broker.fetch({
              maxWaitTime: SEARCH_MAX_WAIT_MS,
              minBytes: 1,
              maxBytes: MAX_BYTES_RESPONSE,
              isolationLevel: ISOLATION_LEVEL.READ_COMMITTED,
              topics: [
                {
                  topic,
                  partitions: localPartitions.map((p) => ({
                    partition: p,
                    fetchOffset: state.get(p)!.nextOffset,
                    maxBytes: MAX_BYTES_PER_PARTITION
                  }))
                }
              ],
              rackId: ''
            })
            responses = res.responses
          } catch (err) {
            if (isStaleMetadataError(err)) {
              needsRebalance = true
              return
            }
            if (isOffsetOutOfRange(err)) {
              const bounds = await fetchBounds(clusterId, topic)
              const byPart = new Map(bounds.map((b) => [b.partition, b]))
              for (const p of localPartitions) {
                const pState = state.get(p)
                const b = byPart.get(p)
                if (!pState || !b) {
                  state.delete(p)
                  continue
                }
                if (compare(pState.nextOffset, b.low) < 0) pState.nextOffset = b.low
                if (compare(pState.nextOffset, pState.end) >= 0) state.delete(p)
              }
              localPartitions = localPartitions.filter((p) => state.has(p))
              continue
            }
            throw err
          }

          let anyMessagesInResponse = false

          for (const topicResp of responses) {
            for (const partData of topicResp.partitions) {
              if (!ctx.isRunning() || stoppedByGuard) break
              const pState = state.get(partData.partition)
              if (!pState) continue

              const fetchedOffset = pState.nextOffset
              const batch = new Batch(topicResp.topicName, fetchedOffset, partData)

              if (batch.messagesWithinOffset.length > 0) {
                anyMessagesInResponse = true
              }

              const inRange = batch.messages.filter((m) => compare(m.offset, pState.end) < 0)

              if (inRange.length > 0) {
                const decodedPairs = await decodeBatch(
                  inRange.map((m) => ({ key: m.key, value: m.value })),
                  serde,
                  { clusterId }
                )

                for (let i = 0; i < inRange.length; i++) {
                  if (!ctx.isRunning() || stoppedByGuard) break
                  const message = inRange[i]
                  const { key, value } = decodedPairs[i]
                  scanned++

                  if (matcher.isEmpty || matcher.matches(value.text) || matcher.matches(key.text)) {
                    matched++
                    ctx.push({
                      topic: topicResp.topicName,
                      partition: partData.partition,
                      offset: message.offset,
                      timestamp: Number(message.timestamp),
                      key,
                      value,
                      headers: decodeHeaders(message.headers),
                      sizeBytes: (message.key?.length ?? 0) + (message.value?.length ?? 0)
                    })

                    const seen = partitionOffsets[partData.partition]
                    if (!seen || compare(message.offset, seen) > 0) {
                      partitionOffsets[partData.partition] = message.offset
                    }
                  }

                  if (matched >= options.maxResults) {
                    stoppedByGuard = true
                    break
                  }

                  if (scanned % 500 === 0) {
                    ctx.progress({
                      phase: 'scanning',
                      scanned,
                      matched,
                      fraction:
                        totalToScan > 0n
                          ? Number((BigInt(scanned) * 100n) / totalToScan) / 100
                          : undefined
                    })
                  }
                }
              }

              if (batch.messagesWithinOffset.length > 0) {
                const last = batch.messagesWithinOffset[batch.messagesWithinOffset.length - 1].offset
                pState.nextOffset = (toBig(last) + 1n).toString()
              } else if (batch.isEmptyDueToLogCompactedMessages()) {
                pState.nextOffset = (toBig(fetchedOffset) + 1n).toString()
              } else if (compare(fetchedOffset, partData.highWatermark) >= 0) {
                state.delete(partData.partition)
                continue
              }

              if (compare(pState.nextOffset, pState.end) >= 0) {
                state.delete(partData.partition)
              }
            }
          }

          if (anyMessagesInResponse) {
            emptyFetches = 0
          } else {
            emptyFetches++
            if (emptyFetches >= MAX_EMPTY_FETCHES) {
              for (const p of localPartitions) state.delete(p)
              break
            }
          }

          localPartitions = localPartitions.filter((p) => state.has(p))
        }
      })
    )

    if (needsRebalance) {
      metadataRetries++
      if (metadataRetries > MAX_STALE_METADATA_RETRIES) {
        throw new KlarityError(
          'CONNECTION_FAILED',
          `Partition leadership for "${topic}" remained unstable after ${MAX_STALE_METADATA_RETRIES} retries.`,
          'Try again shortly.'
        )
      }
      await cluster.refreshMetadata()
    } else {
      break
    }
  }

  ctx.progress({ phase: 'done', scanned, matched })
  return { scanned, matched, partitionOffsets, stoppedByGuard }
}

export async function runSearch(
  ctx: JobContext,
  req: SearchRequest,
  serde: SerdeConfig
): Promise<Omit<JobDone, 'jobId' | 'elapsedMs'>> {
  const plan = await planSearch(req)
  log.info(
    `Search "${req.topic}" over ${plan.length} partitions` +
      (req.filter ? ` filter=${req.filter}` : '')
  )
  ctx.progress({
    phase: 'scanning',
    scanned: 0,
    matched: 0,
    note: `${plan.length} partition${plan.length === 1 ? '' : 's'}`
  })

  return runPlan(ctx, req.clusterId, req.topic, plan, serde, {
    filter: req.filter,
    maxResults: req.maxResults
  })
}

/**
 * Single message fetch: the newest record on a partition, or the one at a given
 * offset. Used by "peek", by the hex viewer, and by the serde "try it" button.
 */
export async function peekOne(
  req: PeekRequest,
  serde: SerdeConfig
): Promise<DecodedMessage | null> {
  const bounds = await fetchBounds(req.clusterId, req.topic)
  const target = bounds.find((b) => b.partition === req.partition)
  if (!target) {
    throw new KlarityError(
      'INVALID_INPUT',
      `Partition ${req.partition} does not exist on "${req.topic}".`
    )
  }
  if (compare(target.low, target.high) === 0) return null // empty partition

  const offset = req.offset ?? (toBig(target.high) - 1n).toString()
  if (compare(offset, target.low) < 0 || compare(offset, target.high) >= 0) {
    throw new KlarityError(
      'OFFSET_OUT_OF_RANGE',
      `Offset ${offset} is outside ${target.low}–${toBig(target.high) - 1n}.`
    )
  }

  const cluster = await fetchClusterFor(req.clusterId)

  for (let attempt = 0; attempt <= MAX_STALE_METADATA_RETRIES; attempt++) {
    const byLeader = await resolveLeaders(cluster, req.topic, [req.partition])
    const entry = [...byLeader.entries()][0]
    if (!entry) return null

    const [nodeId] = entry
    try {
      const broker = await cluster.findBroker({ nodeId })
      const { responses } = await broker.fetch({
        maxWaitTime: TAIL_MAX_WAIT_MS,
        minBytes: 1,
        maxBytes: MAX_BYTES_RESPONSE,
        isolationLevel: ISOLATION_LEVEL.READ_COMMITTED,
        topics: [
          {
            topic: req.topic,
            partitions: [
              { partition: req.partition, fetchOffset: offset, maxBytes: MAX_BYTES_RESPONSE }
            ]
          }
        ],
        rackId: ''
      })

      const partData = responses[0]?.partitions[0]
      if (!partData) return null

      const batch = new Batch(req.topic, offset, partData)
      const message = batch.messages.find((m) => compare(m.offset, offset) === 0)
      if (!message) return null

      const pair = await decodeOne(
        { key: message.key, value: message.value },
        serde,
        { clusterId: req.clusterId },
        { includeRaw: req.includeRaw }
      )
      return {
        topic: req.topic,
        partition: req.partition,
        offset: message.offset,
        timestamp: Number(message.timestamp),
        key: pair.key,
        value: pair.value,
        headers: decodeHeaders(message.headers),
        sizeBytes: (message.key?.length ?? 0) + (message.value?.length ?? 0)
      }
    } catch (err) {
      if (isStaleMetadataError(err) && attempt < MAX_STALE_METADATA_RETRIES) {
        await cluster.refreshMetadata()
        continue
      }
      throw err
    }
  }

  return null
}

/**
 * Live tail: polls forward from the current end of the topic. Guards on both
 * message count and wall time so a forgotten tab cannot accumulate forever.
 */
export async function runTail(
  ctx: JobContext,
  req: TailRequest,
  serde: SerdeConfig
): Promise<Omit<JobDone, 'jobId' | 'elapsedMs'>> {
  const bounds = await fetchBounds(req.clusterId, req.topic)
  const selected =
    req.partition === undefined ? bounds : bounds.filter((b) => b.partition === req.partition)

  const maxMessages = req.maxMessages ?? 10_000
  const maxDurationMs = req.maxDurationMs ?? 30 * 60 * 1000
  const deadline = Date.now() + maxDurationMs
  const matcher = compileFilter(req.filter)
  const partitionOffsets: Record<number, string> = {}

  let scanned = 0
  let matched = 0

  const nextOffsets = new Map(selected.map((b) => [b.partition, b.high]))
  const cluster = await fetchClusterFor(req.clusterId)

  ctx.progress({ phase: 'tailing', scanned: 0, matched: 0 })

  let metadataRetries = 0
  while (ctx.isRunning() && Date.now() < deadline && matched < maxMessages && nextOffsets.size > 0) {
    const byLeader = await resolveLeaders(cluster, req.topic, [...nextOffsets.keys()])
    if (byLeader.size === 0) break

    let needsRebalance = false

    await Promise.all(
      [...byLeader.entries()].map(async ([nodeId, localPartitions]) => {
        let broker
        try {
          broker = await cluster.findBroker({ nodeId })
        } catch (err) {
          if (isStaleMetadataError(err)) {
            needsRebalance = true
            return
          }
          throw err
        }

        while (
          ctx.isRunning() &&
          Date.now() < deadline &&
          matched < maxMessages &&
          !needsRebalance
        ) {
          let responses
          try {
            const res = await broker.fetch({
              maxWaitTime: TAIL_MAX_WAIT_MS,
              minBytes: 1,
              maxBytes: MAX_BYTES_RESPONSE,
              isolationLevel: ISOLATION_LEVEL.READ_COMMITTED,
              topics: [
                {
                  topic: req.topic,
                  partitions: localPartitions.map((p) => ({
                    partition: p,
                    fetchOffset: nextOffsets.get(p)!,
                    maxBytes: MAX_BYTES_PER_PARTITION
                  }))
                }
              ],
              rackId: ''
            })
            responses = res.responses
          } catch (err) {
            if (isStaleMetadataError(err)) {
              needsRebalance = true
              return
            }
            if (isOffsetOutOfRange(err)) {
              const latest = await fetchBounds(req.clusterId, req.topic)
              const byPart = new Map(latest.map((b) => [b.partition, b]))
              for (const p of localPartitions) {
                const b = byPart.get(p)
                if (b) nextOffsets.set(p, b.high)
              }
              continue
            }
            throw err
          }

          for (const topicResp of responses) {
            for (const partData of topicResp.partitions) {
              if (!ctx.isRunning() || matched >= maxMessages) break
              const fetchedOffset = nextOffsets.get(partData.partition)
              if (fetchedOffset === undefined) continue

              const batch = new Batch(topicResp.topicName, fetchedOffset, partData)

              for (const message of batch.messages) {
                if (!ctx.isRunning() || matched >= maxMessages) break
                scanned++

                // Tail is inherently low-volume (new records only), so decoding one
                // at a time is fine here.
                const { key, value } = await decodeOne(
                  { key: message.key, value: message.value },
                  serde,
                  { clusterId: req.clusterId }
                )

                if (matcher.isEmpty || matcher.matches(value.text) || matcher.matches(key.text)) {
                  matched++
                  ctx.push({
                    topic: topicResp.topicName,
                    partition: partData.partition,
                    offset: message.offset,
                    timestamp: Number(message.timestamp),
                    key,
                    value,
                    headers: decodeHeaders(message.headers),
                    sizeBytes: (message.key?.length ?? 0) + (message.value?.length ?? 0)
                  })
                  partitionOffsets[partData.partition] = message.offset
                  // Tail output should appear as it arrives, not in batches of 100.
                  ctx.flush()
                  ctx.progress({ phase: 'tailing', scanned, matched })
                }
              }

              if (batch.messagesWithinOffset.length > 0) {
                const last = batch.messagesWithinOffset[batch.messagesWithinOffset.length - 1].offset
                nextOffsets.set(partData.partition, (toBig(last) + 1n).toString())
              } else if (batch.isEmptyDueToLogCompactedMessages()) {
                nextOffsets.set(partData.partition, (toBig(fetchedOffset) + 1n).toString())
              }
            }
          }
        }
      })
    )

    if (needsRebalance) {
      metadataRetries++
      if (metadataRetries > MAX_STALE_METADATA_RETRIES) {
        throw new KlarityError(
          'CONNECTION_FAILED',
          `Partition leadership for "${req.topic}" remained unstable after ${MAX_STALE_METADATA_RETRIES} retries.`,
          'Try again shortly.'
        )
      }
      await cluster.refreshMetadata()
    } else {
      break
    }
  }

  return { scanned, matched, partitionOffsets, stoppedByGuard: true }
}
