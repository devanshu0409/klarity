/**
 * The complete IPC contract. Single source of truth for main handlers, the
 * preload bridge, and the renderer client — all three are type-checked against
 * the maps below, so a channel cannot drift out of sync on one side only.
 *
 * Conventions:
 *  - Invoke channels are `domain:action`, request/response.
 *  - Anything long-running returns a `JobHandle` and streams over an event
 *    channel; cancel with `job:cancel`.
 *  - Destructive operations take a `confirmToken` that main compares against the
 *    resource name. The renderer collects it by making the user type the name.
 *  - Handlers reject with `AppError`; the renderer never sees a stack trace.
 */

import type {
  AppSettings,
  BrokerInfo,
  ClusterHealth,
  ClusterProfile,
  ClusterProfileInput,
  ConfigEntry,
  DecodedMessage,
  ExportRequest,
  GroupDetail,
  GroupSummary,
  JobDone,
  JobError,
  JobHandle,
  JobMessages,
  JobProgress,
  LagUpdate,
  LoadTestConfig,
  LoadTestMetrics,
  MessageFileRequest,
  PeekRequest,
  ProduceFromFileRequest,
  ProduceRequest,
  ProduceResult,
  ResetOffsetsRequest,
  ResetPreviewRow,
  SavedLoadTest,
  SearchRequest,
  TabGroup,
  TabGroupInput,
  TailRequest,
  TopicDetail,
  TopicSpec,
  TopicSummary,
  UpdateStatus,
  VerifyConfig,
  VerifyUpdate
} from './models'
import type {
  DecodeTestResult,
  FbsSchemaInfo,
  FlatcStatus,
  JarImportResult,
  ProtoSource,
  ProtoTypeInfo,
  SerdeConfig
} from './serde'

/**
 * Request/response channels. Every entry is `(...args) => result`; the preload
 * bridge wraps each in `ipcRenderer.invoke`, so results are always promised on
 * the renderer side (see `AsyncApi`).
 */
export interface InvokeMap {
  // --- clusters ----------------------------------------------------------
  'clusters:list': () => ClusterProfile[]
  'clusters:save': (input: ClusterProfileInput) => ClusterProfile
  'clusters:delete': (id: string) => void
  /** Duplicates a profile, secrets included, under a "(copy)" name. Never connected. */
  'clusters:clone': (id: string) => ClusterProfile
  /** Validates connectivity without persisting anything. */
  'clusters:test': (input: ClusterProfileInput) => ClusterHealth
  'clusters:connect': (id: string) => ClusterHealth
  'clusters:disconnect': (id: string) => void
  'clusters:health': (id: string) => ClusterHealth

  // --- tab groups ----------------------------------------------------------
  'tabGroups:list': (clusterId: string) => TabGroup[]
  'tabGroups:save': (input: TabGroupInput) => TabGroup
  'tabGroups:delete': (id: string) => void

  // --- brokers -----------------------------------------------------------
  'brokers:list': (clusterId: string) => BrokerInfo[]
  'brokers:describeConfigs': (clusterId: string, brokerId: number) => ConfigEntry[]

  // --- topics ------------------------------------------------------------
  /**
   * Served from the metadata snapshot taken at connect. `refresh` forces a new
   * fetch — that is the toolbar's Refresh button, not something to do casually:
   * it is a full metadata round trip, seconds long on a large cluster.
   */
  'topics:list': (clusterId: string, refresh?: boolean) => TopicSummary[]
  'topics:describe': (clusterId: string, topic: string) => TopicDetail
  'topics:create': (clusterId: string, spec: TopicSpec) => void
  'topics:updateConfig': (
    clusterId: string,
    topic: string,
    configs: Record<string, string>
  ) => void
  /**
   * Irreversible, and it breaks key-to-partition affinity for existing keys.
   * `confirmToken` must equal the topic name.
   */
  'topics:addPartitions': (
    clusterId: string,
    topic: string,
    newTotal: number,
    confirmToken: string
  ) => void
  'topics:delete': (clusterId: string, topic: string, confirmToken: string) => void

  // --- consume -----------------------------------------------------------
  'consume:search': (req: SearchRequest) => JobHandle
  'consume:peek': (req: PeekRequest) => DecodedMessage | null
  'consume:tail:start': (req: TailRequest) => JobHandle
  'job:cancel': (jobId: string) => void

  // --- serde -------------------------------------------------------------
  'serde:getTopicConfig': (clusterId: string, topic: string) => SerdeConfig
  'serde:setTopicConfig': (clusterId: string, topic: string, cfg: SerdeConfig) => void
  /** Opens a directory picker when `dir` is omitted. */
  'serde:addProtoSource': (name: string, dir?: string) => ProtoSource
  'serde:listProtoSources': () => ProtoSource[]
  'serde:reloadProtoSource': (id: string) => ProtoSource
  'serde:removeProtoSource': (id: string) => void
  'serde:listProtoTypes': (sourceId: string) => ProtoTypeInfo[]
  /**
   * Recovers `.proto` schemas from jars of compiled protobuf classes, writes
   * them into `outDir`, and registers that directory as a Protobuf source.
   * Omit `jarPaths` or `outDir` to open the corresponding picker.
   */
  'serde:importJars': (
    name: string,
    jarPaths?: string[],
    outDir?: string
  ) => JarImportResult
  /** Opens a file picker when `path` is omitted. */
  'serde:addFbsSchema': (name: string, path?: string) => FbsSchemaInfo
  'serde:listFbsSchemas': () => FbsSchemaInfo[]
  'serde:removeFbsSchema': (id: string) => void
  /** Decodes one live message with a candidate config — the "try it" button. */
  'serde:testDecode': (
    clusterId: string,
    topic: string,
    cfg: SerdeConfig
  ) => DecodeTestResult
  'serde:flatcStatus': () => FlatcStatus

  // --- produce -----------------------------------------------------------
  'produce:single': (req: ProduceRequest) => ProduceResult
  /** Opens a file picker when `filePath` is empty. */
  'produce:fromFile': (req: ProduceFromFileRequest) => ProduceResult

  // --- load test ---------------------------------------------------------
  'loadtest:start': (cfg: LoadTestConfig) => JobHandle
  'loadtest:listSaved': () => SavedLoadTest[]
  'loadtest:saveConfig': (name: string, cfg: Omit<LoadTestConfig, 'clusterId'>) => SavedLoadTest
  'loadtest:deleteSaved': (id: string) => void
  'loadtest:verify:start': (cfg: VerifyConfig) => JobHandle

  // --- consumer groups ---------------------------------------------------
  'groups:list': (clusterId: string, topic?: string) => GroupSummary[]
  'groups:describe': (clusterId: string, groupId: string) => GroupDetail
  /** Starts a polling job; rows stream on `lag:update` until cancelled. */
  'groups:lag:start': (clusterId: string, groupId: string, topic: string) => JobHandle
  /** Dry run: what the reset would set, with range validation. */
  'groups:resetPreview': (req: ResetOffsetsRequest) => ResetPreviewRow[]
  'groups:resetOffsets': (req: ResetOffsetsRequest, confirmToken: string) => void
  'groups:delete': (clusterId: string, groupId: string, confirmToken: string) => void

  // --- export ------------------------------------------------------------
  /** Returns the saved path, or null when the user cancels the dialog. */
  'export:rows': (req: ExportRequest) => string | null
  'export:messageFile': (req: MessageFileRequest) => string | null

  // --- settings & app ----------------------------------------------------
  'settings:get': () => AppSettings
  'settings:set': (patch: Partial<AppSettings>) => AppSettings
  'app:version': () => string
  'update:check': () => void
  'update:download': () => void
  'update:install': () => void
}

/**
 * Main -> renderer streams. Each payload carries its own `jobId` so the renderer
 * can route it without keeping channel-per-job subscriptions.
 */
export interface EventMap {
  'job:progress': JobProgress
  'job:messages': JobMessages
  'job:done': JobDone
  'job:error': JobError
  'lag:update': LagUpdate
  'loadtest:metrics': LoadTestMetrics
  'verify:update': VerifyUpdate
  'cluster:status': ClusterHealth
  'update:status': UpdateStatus
}

export type InvokeChannel = keyof InvokeMap
export type EventChannel = keyof EventMap

/** Argument tuple of an invoke channel, e.g. `[clusterId: string, topic: string]`. */
export type InvokeArgs<C extends InvokeChannel> = Parameters<InvokeMap[C]>
/** Resolved (non-promise) result of an invoke channel. */
export type InvokeResult<C extends InvokeChannel> = ReturnType<InvokeMap[C]>

/**
 * The renderer-facing surface: the same signatures, promised.
 * `window.klarity.invoke` is typed with this.
 */
export type AsyncApi = {
  [C in InvokeChannel]: (...args: InvokeArgs<C>) => Promise<InvokeResult<C>>
}

/** Handler signature main must implement for a channel. May be sync or async. */
export type InvokeHandler<C extends InvokeChannel> = (
  ...args: InvokeArgs<C>
) => InvokeResult<C> | Promise<InvokeResult<C>>

/** The full handler table main registers. Missing a channel is a type error. */
export type InvokeHandlers = { [C in InvokeChannel]: InvokeHandler<C> }

/** Unsubscribe function returned by every event subscription. */
export type Unsubscribe = () => void

export interface KlarityApi {
  invoke: AsyncApi
  on: <C extends EventChannel>(channel: C, cb: (payload: EventMap[C]) => void) => Unsubscribe
}

/**
 * Channel lists used by the preload bridge to build the API without `any`, and
 * to reject channels the renderer is not allowed to reach.
 */
export const INVOKE_CHANNELS = [
  'clusters:list',
  'clusters:save',
  'clusters:clone',
  'clusters:delete',
  
  'clusters:test',
  'clusters:connect',
  'clusters:disconnect',
  'clusters:health',
  'tabGroups:list',
  'tabGroups:save',
  'tabGroups:delete',
  'brokers:list',
  'brokers:describeConfigs',
  'topics:list',
  'topics:describe',
  'topics:create',
  'topics:updateConfig',
  'topics:addPartitions',
  'topics:delete',
  'consume:search',
  'consume:peek',
  'consume:tail:start',
  'job:cancel',
  'serde:getTopicConfig',
  'serde:setTopicConfig',
  'serde:addProtoSource',
  'serde:listProtoSources',
  'serde:reloadProtoSource',
  'serde:removeProtoSource',
  'serde:listProtoTypes',
  'serde:importJars',
  'serde:addFbsSchema',
  'serde:listFbsSchemas',
  'serde:removeFbsSchema',
  'serde:testDecode',
  'serde:flatcStatus',
  'produce:single',
  'produce:fromFile',
  'loadtest:start',
  'loadtest:listSaved',
  'loadtest:saveConfig',
  'loadtest:deleteSaved',
  'loadtest:verify:start',
  'groups:list',
  'groups:describe',
  'groups:lag:start',
  'groups:resetPreview',
  'groups:resetOffsets',
  'groups:delete',
  'export:rows',
  'export:messageFile',
  'settings:get',
  'settings:set',
  'app:version',
  'update:check',
  'update:download',
  'update:install'
] as const satisfies readonly InvokeChannel[]

export const EVENT_CHANNELS = [
  'job:progress',
  'job:messages',
  'job:done',
  'job:error',
  'lag:update',
  'loadtest:metrics',
  'verify:update',
  'cluster:status',
  'update:status'
] as const satisfies readonly EventChannel[]
