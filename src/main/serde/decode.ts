import type { DecodedValue } from '@shared/models'
import { MAX_VALUE_TEXT_BYTES } from '@shared/models'
import type { NumericKind, SerdeConfig, SerdeSpec } from '@shared/serde'
import { NUMERIC_WIDTHS } from '@shared/serde'
import { getProfile } from '../store/profiles'
import { logger } from '../util/log'
import { decodeProtobuf } from './protobuf'
import { decodeFlatBuffersBatch } from './flatbuffers'
import { decodeRegistryPayload, readSchemaId } from './avro'

const log = logger('decode')

/**
 * Decoding contract: a decoder never throws. Failures come back as
 * `format: 'raw'` with `decodeError` set, so one unreadable record cannot abort
 * a scan of a million.
 *
 * FlatBuffers is the reason this module is batch-oriented. It has no JS runtime
 * parser, so decoding shells out to `flatc`; that is only viable once per Kafka
 * batch, never once per message.
 */

export interface DecodeContext {
  clusterId: string
}

export interface DecodeOptions {
  includeRaw?: boolean
}

const NULL_VALUE: DecodedValue = { format: 'null', text: '', truncated: false, sizeBytes: 0 }

// ---------------------------------------------------------------------------
// Batch entry point
// ---------------------------------------------------------------------------

interface Pending {
  index: number
  which: 'key' | 'value'
  buffer: Buffer
  spec: SerdeSpec
}

export interface RawRecord {
  key: Buffer | null
  value: Buffer | null
}

export interface DecodedPair {
  key: DecodedValue
  value: DecodedValue
}

export async function decodeBatch(
  records: RawRecord[],
  serde: SerdeConfig,
  ctx: DecodeContext,
  options: DecodeOptions = {}
): Promise<DecodedPair[]> {
  const out: DecodedPair[] = records.map(() => ({ key: NULL_VALUE, value: NULL_VALUE }))

  const flatbuffers: Pending[] = []
  const registry: Pending[] = []

  for (let i = 0; i < records.length; i++) {
    for (const which of ['key', 'value'] as const) {
      const buffer = records[i][which]
      const spec = serde[which]
      if (buffer === null) continue

      const route = classify(buffer, spec, ctx)
      if (route === 'flatbuffers') {
        flatbuffers.push({ index: i, which, buffer, spec })
      } else if (route === 'registry') {
        registry.push({ index: i, which, buffer, spec })
      } else {
        out[i][which] = decodeSync(buffer, spec, options)
      }
    }
  }

  // One flatc invocation covers the whole batch, grouped by schema so a mixed
  // key/value configuration still only costs one call per distinct schema.
  await Promise.all([
    resolveFlatBuffers(flatbuffers, out, options),
    resolveRegistry(registry, out, ctx, options)
  ])

  return out
}

/** Convenience for single-record paths (peek, serde test). */
export async function decodeOne(
  record: RawRecord,
  serde: SerdeConfig,
  ctx: DecodeContext,
  options: DecodeOptions = {}
): Promise<DecodedPair> {
  const [pair] = await decodeBatch([record], serde, ctx, options)
  return pair
}

type Route = 'sync' | 'flatbuffers' | 'registry'

function classify(buffer: Buffer, spec: SerdeSpec, ctx: DecodeContext): Route {
  if (spec.kind === 'flatbuffers') return 'flatbuffers'
  if (spec.kind === 'avro-sr') return 'registry'
  if (spec.kind === 'auto' && readSchemaId(buffer) !== null && registryEnabled(ctx)) {
    return 'registry'
  }
  return 'sync'
}

function registryEnabled(ctx: DecodeContext): boolean {
  try {
    return getProfile(ctx.clusterId).schemaRegistry.enabled
  } catch {
    return false
  }
}

async function resolveFlatBuffers(
  pending: Pending[],
  out: DecodedPair[],
  options: DecodeOptions
): Promise<void> {
  if (pending.length === 0) return

  // Group by schema + root type: each distinct pair is one flatc call.
  const groups = new Map<string, Pending[]>()
  for (const item of pending) {
    const key = `${item.spec.fbsSchemaId ?? ''}::${item.spec.fbsRootType ?? ''}`
    const list = groups.get(key)
    if (list) list.push(item)
    else groups.set(key, [item])
  }

  for (const [key, items] of groups) {
    const [schemaId, rootType] = key.split('::')
    if (!schemaId) {
      for (const item of items) {
        out[item.index][item.which] = {
          ...rawValue(item.buffer),
          decodeError: 'No FlatBuffers schema is configured for this topic.'
        }
      }
      continue
    }

    try {
      const results = await decodeFlatBuffersBatch(
        items.map((i) => i.buffer),
        schemaId,
        rootType || undefined
      )
      items.forEach((item, index) => {
        const json = results[index]
        out[item.index][item.which] =
          json === null
            ? {
                ...rawValue(item.buffer),
                decodeError: 'flatc could not decode this record with the configured schema.'
              }
            : jsonFromText(json, item.buffer, 'flatbuffers', options)
      })
    } catch (err) {
      // A missing flatc or unreadable schema fails the whole group; every
      // record still renders as raw with the reason attached.
      const message = err instanceof Error ? err.message : 'FlatBuffers decoding failed.'
      log.warn(`FlatBuffers batch failed: ${message}`)
      for (const item of items) {
        out[item.index][item.which] = { ...rawValue(item.buffer), decodeError: message }
      }
    }
  }
}

async function resolveRegistry(
  pending: Pending[],
  out: DecodedPair[],
  ctx: DecodeContext,
  options: DecodeOptions
): Promise<void> {
  if (pending.length === 0) return

  // The registry client caches schemas, so after the first lookup these
  // resolve without further network calls.
  await Promise.all(
    pending.map(async (item) => {
      const schemaId = readSchemaId(item.buffer)
      try {
        const json = await decodeRegistryPayload(item.buffer, ctx.clusterId)
        out[item.index][item.which] = {
          ...jsonFromText(json, item.buffer, 'avro', options),
          ...(schemaId !== null ? { schemaId } : {})
        }
      } catch (err) {
        out[item.index][item.which] = {
          ...rawValue(item.buffer),
          ...(schemaId !== null ? { schemaId } : {}),
          decodeError: err instanceof Error ? err.message : 'Schema Registry decode failed.'
        }
      }
    })
  )
}

// ---------------------------------------------------------------------------
// Synchronous formats
// ---------------------------------------------------------------------------

export function decodeSync(
  buffer: Buffer | null,
  spec: SerdeSpec,
  options: DecodeOptions = {}
): DecodedValue {
  if (buffer === null) return NULL_VALUE

  try {
    switch (spec.kind) {
      case 'raw':
        return rawValue(buffer)
      case 'string':
        return stringValue(buffer, options.includeRaw)
      case 'json':
        return jsonValue(buffer, options.includeRaw, true)
      case 'proto-string':
        return protoStringValue(buffer, options)
      case 'int64':
      case 'int32':
      case 'int16':
      case 'float64':
      case 'float32':
        return numberValue(buffer, spec.kind, options.includeRaw)
      case 'protobuf':
        return protobufValue(buffer, spec, options)
      case 'auto':
        return autoValue(buffer, options.includeRaw)
      default:
        return {
          ...rawValue(buffer),
          decodeError: `${spec.kind} decoding is not available on this path.`
        }
    }
  } catch (err) {
    return {
      ...rawValue(buffer),
      decodeError: err instanceof Error ? err.message : 'Decode failed.'
    }
  }
}

function protoStringValue(buffer: Buffer, options: DecodeOptions): DecodedValue {
  const text = readProtoWrappedString(buffer)
  if (text === null) {
    return {
      ...rawValue(buffer),
      decodeError: 'Not a protobuf-wrapped string (expected a single string in field 1).'
    }
  }
  const { text: truncated, truncated: wasTruncated } = truncate(text)
  return {
    format: 'string',
    text: truncated,
    truncated: wasTruncated,
    sizeBytes: buffer.length,
    ...(options.includeRaw ? { rawBase64: buffer.toString('base64') } : {})
  }
}

/**
 * Kafka's fixed-width serializers, all big-endian: `LongSerializer` (8),
 * `IntegerSerializer` (4), `ShortSerializer` (2), `DoubleSerializer` (8),
 * `FloatSerializer` (4).
 *
 * int64 goes through BigInt — a Java long past 2^53 would otherwise land on the
 * wrong number, and an id is exactly the kind of value that gets large.
 */
export function readNumber(buffer: Buffer, kind: NumericKind): string | null {
  if (buffer.length !== NUMERIC_WIDTHS[kind]) return null
  switch (kind) {
    case 'int64':
      return buffer.readBigInt64BE(0).toString()
    case 'int32':
      return String(buffer.readInt32BE(0))
    case 'int16':
      return String(buffer.readInt16BE(0))
    case 'float64':
      return String(buffer.readDoubleBE(0))
    case 'float32':
      return String(buffer.readFloatBE(0))
  }
}

function numberValue(buffer: Buffer, kind: NumericKind, includeRaw?: boolean): DecodedValue {
  const text = readNumber(buffer, kind)
  if (text === null) {
    return {
      ...rawValue(buffer),
      decodeError: `A ${kind} value is ${NUMERIC_WIDTHS[kind]} bytes; this one is ${buffer.length}.`
    }
  }
  return {
    format: 'number',
    text,
    truncated: false,
    sizeBytes: buffer.length,
    ...(includeRaw ? { rawBase64: buffer.toString('base64') } : {})
  }
}

function protobufValue(buffer: Buffer, spec: SerdeSpec, options: DecodeOptions): DecodedValue {
  if (!spec.protoSourceId || !spec.protoType) {
    return {
      ...rawValue(buffer),
      decodeError: 'No Protobuf message type is configured for this topic.'
    }
  }
  const json = decodeProtobuf(buffer, spec.protoSourceId, spec.protoType, spec.protoFile)
  return jsonFromText(json, buffer, 'protobuf', options)
}

/** Wraps already-produced JSON text in a DecodedValue of the given format. */
function jsonFromText(
  json: string,
  source: Buffer,
  format: DecodedValue['format'],
  options: DecodeOptions
): DecodedValue {
  const { text, truncated } = truncate(json)
  return {
    format,
    text,
    truncated,
    sizeBytes: source.length,
    ...(options.includeRaw ? { rawBase64: source.toString('base64') } : {})
  }
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= MAX_VALUE_TEXT_BYTES) return { text, truncated: false }
  const sliced = Buffer.from(text, 'utf8').subarray(0, MAX_VALUE_TEXT_BYTES).toString('utf8')
  return { text: sliced.replace(/�$/, ''), truncated: true }
}

function rawValue(buffer: Buffer): DecodedValue {
  const preview = buffer.subarray(0, 512).toString('hex').replace(/(.{2})/g, '$1 ').trim()
  return {
    format: 'raw',
    text: preview,
    truncated: buffer.length > 512,
    sizeBytes: buffer.length,
    rawBase64: buffer.toString('base64')
  }
}

function stringValue(buffer: Buffer, includeRaw?: boolean): DecodedValue {
  const { text, truncated } = truncate(buffer.toString('utf8'))
  return {
    format: 'string',
    text,
    truncated,
    sizeBytes: buffer.length,
    ...(includeRaw ? { rawBase64: buffer.toString('base64') } : {})
  }
}

function jsonValue(buffer: Buffer, includeRaw?: boolean, strict = false): DecodedValue {
  const utf8 = buffer.toString('utf8')
  try {
    const parsed: unknown = JSON.parse(utf8)
    return jsonFromText(JSON.stringify(parsed, null, 2), buffer, 'json', { includeRaw })
  } catch (err) {
    if (!strict) throw err
    return {
      ...stringValue(buffer, includeRaw),
      decodeError: err instanceof Error ? `Not valid JSON: ${err.message}` : 'Not valid JSON.'
    }
  }
}

/**
 * Reads a protobuf message that carries nothing but one string in field 1 and
 * returns that string.
 *
 * Producers often send a key as `google.protobuf.StringValue`, or as a
 * one-field wrapper message, rather than as raw text. On the wire that is
 * `0x0A <varint length> <utf8>`. Rendered as plain text it looks like mojibake
 * (a newline, a control byte, then the value), which is exactly what made these
 * keys unreadable.
 *
 * Returns null unless the buffer is *entirely* consumed by that one field, so
 * a real protobuf message that merely starts with a string is not mistaken for
 * a wrapper.
 */
function readProtoWrappedString(buffer: Buffer): string | null {
  // Field 1, wire type 2 (length-delimited).
  if (buffer.length < 2 || buffer[0] !== 0x0a) return null

  let offset = 1
  let length = 0
  let shift = 0
  while (offset < buffer.length) {
    const byte = buffer[offset]
    length |= (byte & 0x7f) << shift
    offset += 1
    if ((byte & 0x80) === 0) break
    shift += 7
    if (shift > 28) return null
  }

  if (length < 0 || offset + length !== buffer.length) return null

  const slice = buffer.subarray(offset)
  const text = slice.toString('utf8')
  // Reject anything that is not clean UTF-8; those bytes are a real message.
  if (text.includes('�')) return null
  if (Buffer.compare(Buffer.from(text, 'utf8'), slice) !== 0) return null
  return text
}

/** True when the bytes decode as UTF-8 without producing replacement chars. */
function isUtf8(buffer: Buffer): boolean {
  const text = buffer.toString('utf8')
  if (text.includes('�')) return false
  return Buffer.compare(Buffer.from(text, 'utf8'), buffer) === 0
}

/**
 * Valid UTF-8 is not the same as readable text: `LongSerializer` writing 196624
 * produces `00 00 00 00 00 03 00 10`, every byte of which is legal UTF-8. Shown
 * as text that is a run of NULs and two control characters — the mystery boxes
 * this rule exists to prevent. Tab, newline and carriage return are the only
 * control characters that belong in real text.
 */
function isPrintableText(buffer: Buffer): boolean {
  if (!isUtf8(buffer)) return false
  const text = buffer.toString('utf8')
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)
}


/**
 * Recognises Kafka's `LongSerializer` / `IntegerSerializer` output.
 *
 * Width alone is not enough — plenty of 4-byte blobs are not numbers — so the
 * high byte must be zero. Every id a producer actually keys on is a small
 * positive number, which puts zeros in the leading bytes, while arbitrary
 * binary rarely starts with one. Shorts are deliberately excluded: two bytes
 * carry too little signal to guess from, and `int16` is still selectable by
 * hand.
 *
 * Floats are never guessed either: every 8-byte buffer is also a valid double,
 * so an id would render as an absurd exponent.
 */
function detectNumber(buffer: Buffer): NumericKind | null {
  if (buffer[0] !== 0x00) return null
  if (buffer.length === 8) return 'int64'
  if (buffer.length === 4) return 'int32'
  return null
}

function autoValue(buffer: Buffer, includeRaw?: boolean): DecodedValue {
  // A protobuf-wrapped string would otherwise render as a newline, a control
  // byte and then the value, so check for it before anything else: its framing
  // is an exact structural match, unlike the guesses below.
  const wrapped = readProtoWrappedString(buffer)
  if (wrapped !== null) {
    const { text, truncated } = truncate(wrapped)
    return {
      format: 'string',
      text,
      truncated,
      sizeBytes: buffer.length,
      ...(includeRaw ? { rawBase64: buffer.toString('base64') } : {})
    }
  }

  // Fixed-width numbers are checked before the registry framing on purpose: a
  // Java long with a zero high byte is byte-identical to the registry's 0x00
  // magic byte, and this branch only runs when no registry is configured, so a
  // Long key is by far the likelier reading.
  if (!isPrintableText(buffer)) {
    const numeric = detectNumber(buffer)
    if (numeric) return numberValue(buffer, numeric, includeRaw)
  }

  // Registry-framed payloads reach here only when no registry is configured;
  // say so instead of showing an unexplained hex dump.
  const schemaId = readSchemaId(buffer)
  if (schemaId !== null) {
    return {
      ...rawValue(buffer),
      schemaId,
      decodeError: `Schema Registry payload (schema id ${schemaId}). Enable Schema Registry on the cluster to decode it.`
    }
  }

  if (!isPrintableText(buffer)) return rawValue(buffer)

  const trimmed = buffer.toString('utf8').trim()
  // Only try JSON when it looks like a document: JSON.parse would happily turn
  // a bare number or `true` into "JSON".
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return jsonValue(buffer, includeRaw)
    } catch {
      // Looked like JSON but was not; fall through to plain text.
    }
  }

  return stringValue(buffer, includeRaw)
}

/**
 * Renders one header value.
 *
 * Headers carry no schema and are not configurable, so this is a fixed rule:
 * readable text, then a fixed-width number, then hex. The number step is what
 * makes byte data legible — a Java producer writing `CUSTOMER_ID` with
 * `LongSerializer` sends eight bytes that are valid UTF-8 and would otherwise
 * render as invisible control characters.
 */
function headerText(buffer: Buffer): string {
  if (isPrintableText(buffer)) return buffer.toString('utf8')

  const numeric = detectNumber(buffer)
  if (numeric) {
    const value = readNumber(buffer, numeric)
    if (value !== null) return value
  }
  return buffer.toString('hex')
}

/**
 * Headers as display strings, one entry per header name.
 *
 * Kafka allows a name to repeat, so a value can be an array; the values are
 * joined rather than dropped, since showing only the first hides data that is
 * genuinely on the record.
 */
export function decodeHeaders(
  headers: Record<string, Buffer | string | (Buffer | string)[] | undefined> | undefined
): Record<string, string> {
  if (!headers) return {}

  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue

    const values = (Array.isArray(value) ? value : [value])
      .filter((entry) => entry !== undefined && entry !== null)
      .map((entry) => (Buffer.isBuffer(entry) ? entry : Buffer.from(String(entry))))

    if (values.length === 0) continue
    out[name] = values.map(headerText).join(', ')
  }
  return out
}
