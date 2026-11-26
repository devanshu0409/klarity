/**
 * Domain models shared between main and renderer.
 *
 * Rule: this directory has no runtime dependencies and no `any`. Everything here
 * must survive structured-clone across the IPC boundary, so: no class instances,
 * no functions, no Date (use epoch millis), no bigint (offsets are strings).
 *
 * Kafka offsets are int64. They arrive from kafkajs as strings and stay strings
 * all the way to the UI; only compare them with `compareOffsets()` in lib/offsets.
 */

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

export type SaslMechanism = 'plain' | 'scram-sha-256' | 'scram-sha-512'

export interface TlsConfig {
  enabled: boolean
  /** PEM contents, not paths — read at save time so the profile stays portable. */
  caCert?: string
  clientCert?: string
  clientKey?: string
  /** Accept self-signed / hostname-mismatched certs. Off by default. */
  rejectUnauthorized: boolean
}

export interface SaslConfig {
  enabled: boolean
  mechanism: SaslMechanism
  username: string
  /** Never populated when leaving main; see `hasPassword`. */
  password?: string
}

export interface SchemaRegistryConfig {
  enabled: boolean
  url: string
  username?: string
  /** Never populated when leaving main; see `hasRegistryPassword`. */
  password?: string
}

export interface ClusterProfile {
  id: string
  name: string
  /** Comma-separated host:port list, as typed by the user. */
  bootstrapServers: string
  /** Free-text grouping, e.g. "dev", "qa". Empty/undefined means ungrouped. */
  folder?: string
  /** Accent color key for the cluster chip — guards against acting on the wrong cluster. */
  color: ClusterColor
  tls: TlsConfig
  sasl: Omit<SaslConfig, 'password'>
  schemaRegistry: Omit<SchemaRegistryConfig, 'password'>
  /** Enforced in main-process handlers, not just hidden in the UI. */
  readOnly: boolean
  /** True when a SASL password is held in the OS vault for this profile. */
  hasPassword: boolean
  hasRegistryPassword: boolean
  createdAt: number
  updatedAt: number
}

export type ClusterColor = 'slate' | 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'teal'

/** Shape accepted by `clusters:save` — secrets travel in, never back out. */
export interface ClusterProfileInput {
  /** Omit for create; provide to update in place. */
  id?: string
  name: string
  bootstrapServers: string
  folder?: string
  color: ClusterColor
  tls: TlsConfig
  sasl: SaslConfig
  schemaRegistry: SchemaRegistryConfig
  readOnly: boolean
  /**
   * `undefined` keeps the stored secret, `null` clears it, a string replaces it.
   * Same convention for `registryPassword`.
   */
  password?: string | null
  registryPassword?: string | null
}

export type ClusterState = 'disconnected' | 'connecting' | 'connected' | 'degraded'

export interface ClusterHealth {
  clusterId: string
  state: ClusterState
  clusterName?: string
  controllerId?: number
  brokerCount: number
  topicCount: number
  /** Round-trip millis of the metadata call that produced this snapshot. */
  latencyMs: number
  checkedAt: number
  error?: string
}

// ---------------------------------------------------------------------------
// Tab groups
// ---------------------------------------------------------------------------

/** A saved set of Browse tabs, so a working set of topics reopens in one click. */
export interface TabGroup {
  id: string
  clusterId: string
  name: string
  /** Topic names, in the order they open as tabs. */
  topics: string[]
  createdAt: number
  updatedAt: number
}

export interface TabGroupInput {
  /** Omit for create; provide to update in place. */
  id?: string
  clusterId: string
  name: string
  topics: string[]
}

// ---------------------------------------------------------------------------
// Brokers
// ---------------------------------------------------------------------------

export interface BrokerInfo {
  nodeId: number
  host: string
  port: number
  rack?: string
  isController: boolean
  /** Partitions for which this broker is the leader, across all topics. */
  leaderPartitionCount?: number
}

export interface ConfigEntry {
  name: string
  value: string
  /** False when the value was explicitly set rather than inherited. */
  isDefault: boolean
  isSensitive: boolean
  isReadOnly: boolean
  source?: string
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

export interface TopicSummary {
  name: string
  partitionCount: number
  replicationFactor: number
  isInternal: boolean
  /** latest - earliest summed across partitions. Approximate: ignores compaction. */
  messageCount?: string
  /** True when at least one partition has fewer in-sync replicas than replicas. */
  underReplicated: boolean
}

export interface PartitionDetail {
  partition: number
  leader: number
  replicas: number[]
  isr: number[]
  earliestOffset: string
  latestOffset: string
  /** latestOffset - earliestOffset. */
  messageCount: string
}

export interface TopicDetail {
  name: string
  isInternal: boolean
  partitions: PartitionDetail[]
  configs: ConfigEntry[]
  totalMessageCount: string
  underReplicatedCount: number
}

export interface TopicSpec {
  name: string
  numPartitions: number
  replicationFactor: number
  configs: Record<string, string>
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type DecodedFormat =
  | 'json'
  | 'protobuf'
  | 'flatbuffers'
  | 'avro'
  | 'string'
  /** A fixed-width big-endian number — Kafka's Long/Integer/Short/Double/Float. */
  | 'number'
  | 'raw'
  | 'null'

export interface DecodedValue {
  format: DecodedFormat
  /** Pretty-printed JSON or UTF-8 text, truncated to MAX_VALUE_TEXT_BYTES. */
  text: string
  truncated: boolean
  sizeBytes: number
  /** Populated for `raw`, or on demand for the hex viewer / save-to-file. */
  rawBase64?: string
  /** Set when a decoder was configured, ran, and failed. Text falls back to raw preview. */
  decodeError?: string
  /** Schema Registry schema id, when the payload carried the magic byte. */
  schemaId?: number
}

export interface DecodedMessage {
  topic: string
  partition: number
  offset: string
  /** Kafka record timestamp, epoch millis. */
  timestamp: number
  key: DecodedValue
  value: DecodedValue
  headers: Record<string, string>
  /** Serialized key + value bytes. */
  sizeBytes: number
}

/** Cap on decoded text shipped over IPC; full bytes stay in main. */
export const MAX_VALUE_TEXT_BYTES = 256 * 1024
/** Messages per `job:messages` event. */
export const MESSAGE_BATCH_SIZE = 100
/** Renderer store row cap before oldest rows are evicted. */
export const RENDERER_ROW_CAP = 50_000

// ---------------------------------------------------------------------------
// Consume requests
// ---------------------------------------------------------------------------

export interface TimeRange {
  /** Epoch millis, inclusive. */
  fromMs?: number
  /** Epoch millis, exclusive. */
  toMs?: number
}

export interface SearchRequest {
  clusterId: string
  topic: string
  /**
   * Contains-match on decoded text, case-insensitive.
   * `a && b` = all terms present; `a || b` = any term present. AND binds first.
   */
  filter?: string
  /** Omit to search every partition. */
  partition?: number
  /** Only meaningful with `partition` — start scanning here instead of the tail window. */
  startOffset?: string
  timeRange?: TimeRange
  maxResults: number
  /** Full scan from earliest. Slow; UI must warn. */
  fromBeginning: boolean
}

export interface PeekRequest {
  clusterId: string
  topic: string
  partition: number
  /** Omit for the newest message on the partition. */
  offset?: string
  /** Return full bytes as base64 regardless of size — used by hex viewer / save-to-file. */
  includeRaw?: boolean
}

export interface TailRequest {
  clusterId: string
  topic: string
  filter?: string
  partition?: number
  /** Hard stop after this many messages. Default 10_000. */
  maxMessages?: number
  /** Hard stop after this many millis. Default 30 min. */
  maxDurationMs?: number
}

export interface JobHandle {
  jobId: string
}

export type JobPhase =
  | 'starting'
  | 'scanning'
  | 'tailing'
  | 'polling'
  | 'producing'
  | 'verifying'
  | 'done'

export interface JobProgress {
  jobId: string
  phase: JobPhase
  scanned: number
  matched: number
  /** 0..1 when bounded work is known, omitted for open-ended tails. */
  fraction?: number
  note?: string
}

export interface JobMessages {
  jobId: string
  messages: DecodedMessage[]
}

export interface JobDone {
  jobId: string
  scanned: number
  matched: number
  elapsedMs: number
  /** Highest offset seen per partition — feeds verification auto-fill. */
  partitionOffsets: Record<number, string>
  /** True when the job stopped on a guard (max messages / duration) rather than completing. */
  stoppedByGuard?: boolean
}

export interface JobError {
  jobId: string
  error: AppError
}

// ---------------------------------------------------------------------------
// Produce
// ---------------------------------------------------------------------------

export interface ProduceRequest {
  clusterId: string
  topic: string
  /** Text as typed; encoded per the topic's key serde. */
  key?: string
  value: string
  headers?: Record<string, string>
  /** Omit for the default partitioner. */
  partition?: number
}

export interface ProduceFromFileRequest {
  clusterId: string
  topic: string
  filePath: string
  /** Whether the file bytes become the key or the value. */
  target: 'key' | 'value'
  /** `binary` sends bytes untouched; `text` reads UTF-8 and runs the configured serde. */
  mode: 'binary' | 'text'
  /** Counterpart field, as text. */
  counterpart?: string
  headers?: Record<string, string>
  partition?: number
}

export interface ProduceResult {
  topic: string
  partition: number
  offset: string
  timestamp: number
}

// ---------------------------------------------------------------------------
// Load test
// ---------------------------------------------------------------------------

/** Dot-path into the JSON template, e.g. `event.id` or `items.0.sku`. */
export type FieldPath = string

export interface AutoIncrementRule {
  field: FieldPath
  start: number
  step: number
}

export interface RotationRule {
  field: FieldPath
  values: string[]
}

export interface HeaderRule {
  key: string
  /** Static value; when omitted the value is read from the message field named `key`. */
  value?: string
}

export type PartitionStrategy =
  | { kind: 'auto' }
  | { kind: 'fixed'; partition: number }
  | { kind: 'field'; field: FieldPath }
  | { kind: 'constant'; key: string }

export interface LoadTestConfig {
  clusterId: string
  topic: string
  /** JSON document used as the base for every generated message. */
  template: string
  totalMessages: number
  /** Parallel send workers. */
  concurrency: number
  /** Records per producer batch. */
  batchSize: number
  autoIncrement: AutoIncrementRule[]
  rotation: RotationRule[]
  /** Fields that get a fresh UUID v4 per message. */
  uuidFields: FieldPath[]
  headers: HeaderRule[]
  partitionStrategy: PartitionStrategy
  /** Optional ceiling on send rate; omit for unthrottled. */
  maxMessagesPerSecond?: number
}

export interface LoadTestMetrics {
  jobId: string
  sent: number
  errors: number
  messagesPerSecond: number
  p50LatencyMs: number
  p99LatencyMs: number
  elapsedMs: number
  /** Highest acked offset per partition — auto-fills verification targets. */
  partitionOffsets: Record<number, string>
}

/** Named, reusable load-test setup persisted in userData. */
export interface SavedLoadTest {
  id: string
  name: string
  config: Omit<LoadTestConfig, 'clusterId'>
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifyConfig {
  clusterId: string
  topic: string
  groupIds: string[]
  /** partition -> offset the group must reach. */
  targets: Record<number, string>
  timeoutMs: number
}

export interface VerifyPartitionState {
  partition: number
  committed: string
  target: string
  /** 0..1 */
  fraction: number
  done: boolean
}

export interface VerifyUpdate {
  jobId: string
  groupId: string
  partitions: VerifyPartitionState[]
  done: boolean
  timedOut: boolean
  elapsedMs: number
}

// ---------------------------------------------------------------------------
// Consumer groups
// ---------------------------------------------------------------------------

export type GroupState =
  | 'Unknown'
  | 'PreparingRebalance'
  | 'CompletingRebalance'
  | 'Stable'
  | 'Dead'
  | 'Empty'

export interface GroupSummary {
  groupId: string
  state: GroupState
  memberCount: number
  /** Topics the group has committed offsets for. */
  topics: string[]
  protocolType?: string
}

export interface GroupMember {
  memberId: string
  clientId: string
  clientHost: string
  assignments: { topic: string; partitions: number[] }[]
}

export interface GroupDetail {
  groupId: string
  state: GroupState
  protocol?: string
  protocolType?: string
  coordinatorId?: number
  members: GroupMember[]
}

export interface LagRow {
  partition: number
  /** `null` when the group has never committed for this partition. */
  committed: string | null
  endOffset: string
  lag: string
  memberId?: string
  clientId?: string
}

export interface LagUpdate {
  jobId: string
  groupId: string
  topic: string
  rows: LagRow[]
  totalLag: string
  ts: number
}

export type ResetStrategy =
  | { kind: 'earliest' }
  | { kind: 'latest' }
  | { kind: 'to-datetime'; timestampMs: number }
  | { kind: 'shift-by'; delta: number }
  /** Offset Explorer parity: hand-edited per-partition offsets. */
  | { kind: 'explicit'; offsets: Record<number, string> }

export interface ResetOffsetsRequest {
  clusterId: string
  groupId: string
  topic: string
  strategy: ResetStrategy
  /** Omit to reset every partition of the topic. */
  partitions?: number[]
}

/** What a reset would do, per partition — shown for confirmation before applying. */
export interface ResetPreviewRow {
  partition: number
  current: string | null
  next: string
  earliest: string
  latest: string
  /** True when `next` falls outside [earliest, latest]. */
  outOfRange: boolean
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type ExportFormat = 'json' | 'csv'

export interface ExportRequest {
  /** Suggested filename, without extension. */
  suggestedName: string
  format: ExportFormat
  /** Rows as plain objects; CSV columns come from the first row's keys. */
  rows: Record<string, string | number | boolean | null>[]
}

export interface MessageFileRequest {
  clusterId: string
  topic: string
  partition: number
  offset: string
  target: 'key' | 'value'
  /** `binary` writes the exact bytes; `text` writes the decoded text. */
  mode: 'binary' | 'text'
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AppErrorCode =
  | 'READ_ONLY'
  | 'CONFIRM_MISMATCH'
  | 'NOT_CONNECTED'
  | 'CONNECTION_FAILED'
  | 'AUTH_FAILED'
  | 'TLS_FAILED'
  | 'TOPIC_NOT_FOUND'
  | 'GROUP_NOT_EMPTY'
  | 'OFFSET_OUT_OF_RANGE'
  | 'SERDE_CONFIG'
  | 'DECODE_FAILED'
  | 'SCHEMA_LOAD_FAILED'
  | 'FLATC_MISSING'
  | 'JOB_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'CANCELLED'
  | 'UNKNOWN'

/** The only error shape the renderer ever sees. Stacks stay in main. */
export interface AppError {
  code: AppErrorCode
  message: string
  /** Safe, user-facing extra context. Never raw stack traces. */
  details?: string
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type ThemePreference = 'system' | 'light' | 'dark'
export type Density = 'comfortable' | 'compact'

export interface AppSettings {
  theme: ThemePreference
  density: Density
  /** Overrides the bundled binary when the user supplies their own. */
  flatcPath?: string
  /** Default row cap for searches. */
  defaultMaxResults: number
}

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
  message?: string
}
