import { createRequire } from 'node:module'
import kafkajs, {
  type Admin,
  type ITopicMetadata,
  type Kafka as KafkaClient,
  type KafkaConfig,
  type SASLOptions
} from 'kafkajs'
import type { ClusterHealth, ClusterProfile, ClusterProfileInput } from '@shared/models'
import { KlarityError, notConnected, readOnly } from '../util/errors'
import { logger } from '../util/log'
import { getProfile, getSecrets, splitBootstrap, validateInput } from '../store/profiles'

const log = logger('kafka')
const require = createRequire(import.meta.url)

// kafkajs is CommonJS; take values off the default export so Node's ESM loader
// does not have to guess at named exports.
const { Kafka, logLevel } = kafkajs

const KafkaCluster = require('kafkajs/src/cluster')
const defaultSocketFactory = require('kafkajs/src/network/socketFactory')
const ISOLATION_LEVEL = require('kafkajs/src/protocol/isolationLevel')
const { createLogger } = require('kafkajs/src/loggers')
const LoggerConsole = require('kafkajs/src/loggers/console')

export interface KafkaFetchMessage {
  offset: string
  timestamp: string
  key: Buffer | null
  value: Buffer | null
  headers?: Record<string, Buffer | string | (Buffer | string)[] | undefined>
  isControlRecord?: boolean
}

export interface KafkaFetchPartitionResponse {
  partition: number
  errorCode: number
  highWatermark: string
  abortedTransactions?: Array<{ producerId: string; firstOffset: string }>
  messages: KafkaFetchMessage[]
}

export interface KafkaFetchBroker {
  fetch: (params: {
    replicaId?: number
    isolationLevel?: number
    maxWaitTime?: number
    minBytes?: number
    maxBytes?: number
    topics: Array<{
      topic: string
      partitions: Array<{ partition: number; fetchOffset: string; maxBytes: number }>
    }>
    rackId?: string
  }) => Promise<{
    responses: Array<{
      topicName: string
      partitions: KafkaFetchPartitionResponse[]
    }>
  }>
}

export interface KafkaFetchCluster {
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  addTargetTopic: (topic: string) => Promise<void>
  refreshMetadata: () => Promise<void>
  refreshMetadataIfNecessary: () => Promise<void>
  findTopicPartitionMetadata: (
    topic: string
  ) => Array<{ partitionId: number; leader: number; partitionErrorCode: number }>
  findLeaderForPartitions: (topic: string, partitions: number[]) => Record<string, number[]>
  findBroker: (opts: { nodeId: string }) => Promise<KafkaFetchBroker>
}

interface Connection {
  profile: ClusterProfile
  kafka: KafkaClient
  admin: Admin
  health: ClusterHealth
  /** Shared topic metadata — see `topicMetadata` for why it is cached here. */
  metadata?: { fetchedAt: number; topics: Promise<ITopicMetadata[]> }
  /** Direct-fetch cluster (no consumer group) for browsing, peeking and tailing. */
  fetchCluster?: KafkaFetchCluster
  fetchClusterPending?: Promise<KafkaFetchCluster>
}

/**
 * How long a cached metadata snapshot is served before a caller triggers a
 * fresh fetch. Five minutes matches kafkajs's own `metadataMaxAge` default, and
 * topic sets change rarely: a fetch costs seconds on a large cluster, so a
 * short TTL would hand that cost back at random moments. Klarity's own topic
 * create/delete/add-partitions drop the cache immediately, and the toolbar's
 * Refresh forces a fetch, so the only staleness left is a topic somebody else
 * created since the last look.
 */
const METADATA_TTL_MS = 5 * 60_000

/**
 * One kafkajs client per cluster profile. Handlers resolve a client by
 * `clusterId`, so a request cannot reach a cluster other than the one the UI
 * asked for — there is no ambient "current cluster" anywhere in main.
 */
const connections = new Map<string, Connection>()

function buildConfig(
  profile: Pick<ClusterProfile, 'bootstrapServers' | 'tls' | 'sasl'>,
  password: string | undefined
): KafkaConfig {
  const brokers = splitBootstrap(profile.bootstrapServers)

  let ssl: KafkaConfig['ssl']
  if (profile.tls.enabled) {
    ssl = {
      rejectUnauthorized: profile.tls.rejectUnauthorized,
      ...(profile.tls.caCert ? { ca: [profile.tls.caCert] } : {}),
      ...(profile.tls.clientCert ? { cert: profile.tls.clientCert } : {}),
      ...(profile.tls.clientKey ? { key: profile.tls.clientKey } : {})
    }
  }

  let sasl: SASLOptions | undefined
  if (profile.sasl.enabled) {
    if (!password) {
      throw new KlarityError(
        'AUTH_FAILED',
        'No password is stored for this cluster.',
        'Edit the cluster and enter the SASL password again.'
      )
    }
    sasl = {
      mechanism: profile.sasl.mechanism,
      username: profile.sasl.username,
      password
    } as SASLOptions
  }

  return {
    clientId: 'klarity',
    brokers,
    ssl,
    sasl,
    // Fail fast: a GUI should surface an unreachable broker in seconds, not
    // sit on kafkajs's minute-long default retry budget.
    connectionTimeout: 10_000,
    requestTimeout: 30_000,
    retry: { retries: 2, initialRetryTime: 300, maxRetryTime: 3_000 },
    logLevel: logLevel.ERROR
  }
}

/**
 * A cluster-wide election can still make an *individual* request fail — not
 * the all-topics metadata call (see `metadataTolerance.ts`, which stops one
 * sick topic from failing that), but calls that genuinely need a leader, like
 * fetching offsets for a partition that is electing one right now.
 *
 * kafkajs retries `LEADER_NOT_AVAILABLE` itself, but only within the `retry`
 * budget passed to `new Kafka(...)` — a few seconds. This waits longer before
 * surfacing a clear message instead of the raw protocol error.
 */
const LEADER_ELECTION_DEADLINE_MS = 60_000

/** Unwraps kafkajs's `KafkaJSNumberOfRetriesExceeded` to the protocol error it wraps. */
function rootCause(err: unknown): unknown {
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined
  return cause ?? err
}

function isLeaderElection(err: unknown): boolean {
  const cause = rootCause(err)
  return cause instanceof Error && (cause as Error & { type?: string }).type === 'LEADER_NOT_AVAILABLE'
}

export async function retryThroughElection<T>(
  label: string,
  fn: () => Promise<T>,
  deadlineMs = LEADER_ELECTION_DEADLINE_MS
): Promise<T> {
  const deadline = Date.now() + deadlineMs
  let attempt = 0

  for (;;) {
    try {
      return await fn()
    } catch (err) {
      if (!isLeaderElection(err) || Date.now() >= deadline) {
        if (isLeaderElection(err)) {
          throw new KlarityError(
            'CONNECTION_FAILED',
            `The cluster is still running a leader election after ${Math.round(deadlineMs / 1000)}s of retrying.`,
            'This usually clears on its own — try again shortly.'
          )
        }
        throw err
      }
      attempt += 1
      const delay = Math.min(1_000 * attempt, 5_000)
      log.warn(`${label}: leader election in progress, retrying in ${delay}ms`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

/**
 * Connectivity check plus the facts the status bar shows.
 *
 * These run in parallel because each is a full metadata round trip on a large
 * cluster — measured on `p19-dev` (1865 topics): describeCluster 4-8s,
 * listTopics 3.3s. Per-topic errors no longer fail them (see
 * `metadataTolerance.ts`), so a cluster with a partition mid-election reports
 * its brokers like any other.
 */
async function probe(
  kafka: KafkaClient,
  countTopics: boolean
): Promise<{
  admin: Admin
  clusterName?: string
  controllerId?: number
  brokerCount: number
  topicCount: number
  latencyMs: number
}> {
  const admin = kafka.admin()
  const started = Date.now()
  await admin.connect()

  const [cluster, topicNames] = await Promise.all([
    retryThroughElection('describeCluster', () => admin.describeCluster()),
    countTopics ? retryThroughElection('listTopics', () => admin.listTopics()) : Promise.resolve(null)
  ])

  return {
    admin,
    clusterName: cluster.clusterId,
    controllerId: cluster.controller ?? undefined,
    brokerCount: cluster.brokers.length,
    topicCount: topicNames?.length ?? 0,
    latencyMs: Date.now() - started
  }
}

/** Connectivity check for an unsaved form. Nothing is persisted or cached. */
export async function testProfile(input: ClusterProfileInput): Promise<ClusterHealth> {
  validateInput(input)
  const kafka = new Kafka(buildConfig(input, input.password ?? undefined))
  const started = Date.now()
  let admin: Admin | undefined
  try {
    const result = await probe(kafka, true)
    admin = result.admin
    return {
      clusterId: input.id ?? 'unsaved',
      state: 'connected',
      clusterName: result.clusterName,
      controllerId: result.controllerId,
      brokerCount: result.brokerCount,
      topicCount: result.topicCount,
      latencyMs: result.latencyMs,
      checkedAt: Date.now()
    }
  } catch (err) {
    return {
      clusterId: input.id ?? 'unsaved',
      state: 'disconnected',
      brokerCount: 0,
      topicCount: 0,
      latencyMs: Date.now() - started,
      checkedAt: Date.now(),
      error: err instanceof Error ? err.message : 'Connection failed.'
    }
  } finally {
    if (admin) await admin.disconnect().catch(() => undefined)
  }
}

export async function connect(clusterId: string): Promise<ClusterHealth> {
  const existing = connections.get(clusterId)
  if (existing) return existing.health

  const profile = getProfile(clusterId)
  const { password } = getSecrets(clusterId)
  const kafka = new Kafka(buildConfig(profile, password))

  const result = await probe(kafka, false)
  const health: ClusterHealth = {
    clusterId,
    state: 'connected',
    clusterName: result.clusterName,
    controllerId: result.controllerId,
    brokerCount: result.brokerCount,
    topicCount: result.topicCount,
    latencyMs: result.latencyMs,
    checkedAt: Date.now()
  }

  connections.set(clusterId, { profile, kafka, admin: result.admin, health })
  log.info(`Connected to "${profile.name}" (${result.brokerCount} brokers, ${result.latencyMs}ms)`)

  return health
}

export async function disconnect(clusterId: string): Promise<void> {
  const conn = connections.get(clusterId)
  if (!conn) return
  connections.delete(clusterId)
  const fetchCluster = conn.fetchCluster ?? (await conn.fetchClusterPending?.catch(() => undefined))
  await Promise.all([
    conn.admin.disconnect().catch((err: unknown) => {
      log.warn(`Admin disconnect for ${clusterId} failed`, err)
    }),
    fetchCluster?.disconnect().catch((err: unknown) => {
      log.warn(`Fetch cluster disconnect for ${clusterId} failed`, err)
    })
  ])
  log.info(`Disconnected from "${conn.profile.name}"`)
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([...connections.keys()].map(disconnect))
}

/** Admin client for a connected cluster. Throws when it is not connected. */
export function adminFor(clusterId: string): Admin {
  const conn = connections.get(clusterId)
  if (!conn) throw notConnected(clusterId)
  return conn.admin
}

/**
 * Topic metadata for the whole cluster, cached per connection.
 *
 * `fetchTopicMetadata()` is not cached by kafkajs — every call is a fresh
 * round trip, 5.5s on a 1865-topic cluster — so connect, the topic list and
 * anything else that wants the topic set would each pay it in full. The
 * in-flight promise is cached rather than its result, so simultaneous callers
 * share one request instead of starting several.
 */
export function topicMetadata(clusterId: string, refresh = false): Promise<ITopicMetadata[]> {
  const conn = connections.get(clusterId)
  if (!conn) throw notConnected(clusterId)

  const fresh = conn.metadata && Date.now() - conn.metadata.fetchedAt < METADATA_TTL_MS
  if (!refresh && fresh && conn.metadata) return conn.metadata.topics

  const pending = retryThroughElection(`fetchTopicMetadata(${clusterId})`, () =>
    conn.admin.fetchTopicMetadata()
  )
    .then((result) => {
      // Keep the status bar's topic count in step with what was just read.
      conn.health = { ...conn.health, topicCount: result.topics.length }
      return result.topics
    })
    .catch((err: unknown) => {
      // A failed fetch must not be cached as the answer for the next 30s.
      if (conn.metadata?.topics === pending) conn.metadata = undefined
      throw err
    })

  conn.metadata = { fetchedAt: Date.now(), topics: pending }
  return pending
}

/**
 * Starts the topic-metadata fetch without waiting for it.
 *
 * That fetch is the slow call — 5.5s on a 1865-topic cluster — and the first
 * thing the topic list asks for, so connect returns as soon as the cluster
 * itself answers and the list either finds the result ready or joins the
 * request already in flight. Resolves to the topic count, which the caller
 * pushes to the status bar.
 */
export function warmTopicMetadata(clusterId: string): Promise<number> {
  return topicMetadata(clusterId).then((topics) => topics.length)
}

/** Drops the cached metadata after a topic is created, deleted or resized. */
export function invalidateTopicMetadata(clusterId: string): void {
  const conn = connections.get(clusterId)
  if (conn) conn.metadata = undefined
}

/** The kafkajs client, for producers built in later phases. */
export function kafkaFor(clusterId: string): KafkaClient {
  const conn = connections.get(clusterId)
  if (!conn) throw notConnected(clusterId)
  return conn.kafka
}

/**
 * Connected kafkajs Cluster for direct `broker.fetch()` calls without joining
 * a consumer group. Lazily initialized on first browse/peek/tail.
 */
export async function fetchClusterFor(clusterId: string): Promise<KafkaFetchCluster> {
  const conn = connections.get(clusterId)
  if (!conn) throw notConnected(clusterId)
  if (conn.fetchCluster) return conn.fetchCluster
  if (!conn.fetchClusterPending) {
    conn.fetchClusterPending = (async () => {
      const cfg = buildConfig(conn.profile, getSecrets(clusterId).password)
      const cluster = new KafkaCluster({
        logger: createLogger({ level: logLevel.ERROR, logCreator: LoggerConsole }),
        retry: cfg.retry,
        socketFactory: defaultSocketFactory(),
        brokers: cfg.brokers,
        ssl: cfg.ssl,
        sasl: cfg.sasl,
        clientId: cfg.clientId,
        connectionTimeout: cfg.connectionTimeout,
        requestTimeout: cfg.requestTimeout,
        enforceRequestTimeout: true,
        metadataMaxAge: METADATA_TTL_MS,
        allowAutoTopicCreation: false,
        maxInFlightRequests: null,
        isolationLevel: ISOLATION_LEVEL.READ_COMMITTED
      }) as KafkaFetchCluster
      await cluster.connect()
      conn.fetchCluster = cluster
      return cluster
    })().catch((err) => {
      conn.fetchClusterPending = undefined
      throw err
    })
  }
  return conn.fetchClusterPending
}

export function isConnected(clusterId: string): boolean {
  return connections.has(clusterId)
}

export function healthFor(clusterId: string): ClusterHealth {
  const conn = connections.get(clusterId)
  if (conn) return conn.health
  return {
    clusterId,
    state: 'disconnected',
    brokerCount: 0,
    topicCount: 0,
    latencyMs: 0,
    checkedAt: Date.now()
  }
}

/**
 * Gate for every write path. Reads the profile from the pool (or the store when
 * not connected) so a stale renderer copy of the flag cannot authorize a write.
 */
export function assertWritable(clusterId: string, action: string): void {
  const profile = connections.get(clusterId)?.profile ?? getProfile(clusterId)
  if (profile.readOnly) throw readOnly(action)
}

/** Called when a profile is edited or removed, so the next call reconnects. */
export async function invalidate(clusterId: string): Promise<void> {
  if (connections.has(clusterId)) await disconnect(clusterId)
}
