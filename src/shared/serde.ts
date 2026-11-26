/**
 * Serde configuration types.
 *
 * A topic's key and value are configured independently. `auto` runs the
 * detection pipeline documented in PLAN.md §6.2; every other mode is explicit
 * and reports a decode error rather than silently falling back, so a
 * misconfigured topic is visible instead of quietly rendering as raw.
 */

export type SerdeKind =
  | 'auto'
  | 'json'
  | 'string'
  | 'raw'
  /** A bare string wrapped in a protobuf message — see `proto-string` below. */
  | 'proto-string'
  /**
   * Fixed-width big-endian numbers, matching Kafka's own serializers
   * (`LongSerializer`, `IntegerSerializer`, `ShortSerializer`,
   * `DoubleSerializer`, `FloatSerializer`). Very common for keys and headers,
   * and unreadable as text: the leading bytes of a small number are NULs, so a
   * UTF-8 render shows control characters instead of digits.
   */
  | 'int64'
  | 'int32'
  | 'int16'
  | 'float64'
  | 'float32'
  | 'protobuf'
  | 'flatbuffers'
  | 'avro-sr'

/** Byte width each fixed-width numeric kind occupies on the wire. */
export const NUMERIC_WIDTHS: Record<'int64' | 'int32' | 'int16' | 'float64' | 'float32', number> = {
  int64: 8,
  int32: 4,
  int16: 2,
  float64: 8,
  float32: 4
}

export type NumericKind = keyof typeof NUMERIC_WIDTHS

export function isNumericKind(kind: SerdeKind): kind is NumericKind {
  return kind in NUMERIC_WIDTHS
}

export interface SerdeSpec {
  kind: SerdeKind
  /** Fully-qualified Protobuf message type, e.g. `acme.orders.v1.Order`. */
  protoType?: string
  /** Id of the registered schema source that owns `protoType`. */
  protoSourceId?: string
  /**
   * File the type is declared in, relative to the source directory. Required
   * to disambiguate sources whose `.proto` files declare no package, where the
   * same type name can appear in several files.
   */
  protoFile?: string
  /** Id of the registered `.fbs` schema. */
  fbsSchemaId?: string
  /** Root table name inside the `.fbs`; defaults to the schema's `root_type`. */
  fbsRootType?: string
}

export interface SerdeConfig {
  key: SerdeSpec
  value: SerdeSpec
}

export const DEFAULT_SERDE: SerdeConfig = {
  key: { kind: 'auto' },
  value: { kind: 'auto' }
}

// ---------------------------------------------------------------------------
// Schema sources
// ---------------------------------------------------------------------------

/** A directory of `.proto` files, parsed once and cached as a protobufjs Root. */
export interface ProtoSource {
  id: string
  name: string
  /** Root directory; imports resolve relative to it. */
  dir: string
  /** Populated after a successful load. */
  types: ProtoTypeInfo[]
  loadedAt?: number
  /** Set when the source produced no usable types at all. */
  error?: string
  /**
   * Set when the source loaded but some files were skipped — common in schemas
   * with no `package`, where two files can declare the same type name.
   */
  warning?: string
  /** Files that could not be parsed, with the reason. */
  skipped?: { file: string; reason: string }[]
}

export interface ProtoTypeInfo {
  /** Fully-qualified name used in `SerdeSpec.protoType`. */
  fullName: string
  /** Source file the type was declared in, relative to the source dir. */
  file: string
  fieldCount: number
}

export interface FbsSchemaInfo {
  id: string
  name: string
  path: string
  /** Tables declared in the schema; the first is usually the root. */
  tables: string[]
  rootType?: string
  loadedAt?: number
  error?: string
}

/** Result of trying a candidate serde against a live message. */
export interface DecodeTestResult {
  ok: boolean
  /** Decoded text on success, error message on failure. */
  preview: string
  format: string
  /** Where the sample came from, so the user can tell an empty topic from a bad config. */
  sampledFrom?: { partition: number; offset: string }
  error?: string
}

/** Runtime status of the FlatBuffers toolchain, surfaced in Settings. */
export interface FlatcStatus {
  available: boolean
  path?: string
  version?: string
  /** True when the user supplied the path instead of using the bundled binary. */
  userProvided: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// Jar import
// ---------------------------------------------------------------------------

/** How a recovered `.proto` file was obtained from a jar. */
export type JarImportOrigin = 'proto' | 'descriptor-set' | 'class'

export interface JarImportedFile {
  /** Proto path, e.g. `acme/orders/v1/order.proto`. */
  path: string
  origin: JarImportOrigin
  /** The jar (and entry) it came from. */
  source: string
  /** Populated while writing; blank in the IPC result to keep payloads small. */
  content: string
}

export interface JarImportResult {
  /** Directory the `.proto` files were written to. */
  outDir: string
  classesScanned: number
  files: JarImportedFile[]
}
