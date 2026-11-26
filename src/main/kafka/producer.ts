import { readFileSync, statSync } from 'node:fs'
import kafkajs, { type Producer } from 'kafkajs'
import type { ProduceFromFileRequest, ProduceRequest, ProduceResult } from '@shared/models'
import type { NumericKind, SerdeSpec } from '@shared/serde'
import { NUMERIC_WIDTHS } from '@shared/serde'
import { KlarityError, invalid } from '../util/errors'
import { encodeFlatBuffers } from '../serde/flatbuffers'
import { encodeProtobuf } from '../serde/protobuf'
import { registryFor } from '../serde/avro'
import { getTopicSerde } from '../store/serdeStore'
import { logger } from '../util/log'
import { adminFor, assertWritable, kafkaFor } from './connectionPool'

// kafkajs is CommonJS; take enum values off the default export.
const { ConfigResourceTypes } = kafkajs

const log = logger('produce')

/** Files larger than this are a mistake, not a message. Kafka's own default is 1 MiB. */
const MAX_FILE_BYTES = 8 * 1024 * 1024

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Protobuf's `StringValue` wrapper: field 1, wire type 2, then the UTF-8 bytes.
 * Written by hand because the wrapper is three bytes of framing and pulling in
 * a `Root` for it would mean shipping a `.proto` no user registered — the
 * decoder reads it the same way (see `readProtoWrappedString`).
 */
function encodeProtoWrappedString(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')

  const length: number[] = []
  let remaining = payload.length
  do {
    const byte = remaining & 0x7f
    remaining >>>= 7
    length.push(remaining > 0 ? byte | 0x80 : byte)
  } while (remaining > 0)

  return Buffer.concat([Buffer.from([0x0a]), Buffer.from(length), payload])
}

/**
 * The write side of Kafka's fixed-width serializers, big-endian like the
 * decoder. int64 goes through BigInt so a Java long past 2^53 survives the trip
 * that `Number` would round off.
 */
function encodeNumber(text: string, kind: NumericKind): Buffer {
  const trimmed = text.trim()
  const buffer = Buffer.alloc(NUMERIC_WIDTHS[kind])

  try {
    switch (kind) {
      case 'int64':
        buffer.writeBigInt64BE(BigInt(trimmed), 0)
        break
      case 'int32':
        buffer.writeInt32BE(requireInteger(trimmed, kind), 0)
        break
      case 'int16':
        buffer.writeInt16BE(requireInteger(trimmed, kind), 0)
        break
      case 'float64':
        buffer.writeDoubleBE(requireFinite(trimmed, kind), 0)
        break
      case 'float32':
        buffer.writeFloatBE(requireFinite(trimmed, kind), 0)
        break
    }
  } catch (err) {
    if (err instanceof KlarityError) throw err
    throw new KlarityError(
      'SERDE_CONFIG',
      `"${trimmed}" is out of range for ${kind}.`,
      err instanceof Error ? err.message : undefined
    )
  }

  return buffer
}

function requireFinite(text: string, kind: NumericKind): number {
  const value = Number(text)
  if (text === '' || !Number.isFinite(value)) {
    throw new KlarityError('SERDE_CONFIG', `"${text}" is not a number, and ${kind} needs one.`)
  }
  return value
}

function requireInteger(text: string, kind: NumericKind): number {
  const value = requireFinite(text, kind)
  if (!Number.isInteger(value)) {
    throw new KlarityError('SERDE_CONFIG', `${kind} needs a whole number, not "${text}".`)
  }
  return value
}

/** Confluent subject naming: `<topic>-key` / `<topic>-value` (TopicNameStrategy). */
function subjectFor(topic: string, target: 'key' | 'value'): string {
  return `${topic}-${target}`
}

/**
 * Turns typed text into the bytes a topic expects, mirroring the decode
 * pipeline in §6.2. `auto` has no encode counterpart — detection only makes
 * sense on bytes that already exist — so it sends UTF-8, which is what the
 * decoder's `auto` will read back as JSON or string.
 */
export async function encodeValue(
  text: string,
  spec: SerdeSpec,
  clusterId: string,
  topic: string,
  target: 'key' | 'value'
): Promise<Buffer> {
  switch (spec.kind) {
    case 'auto':
    case 'json':
    case 'string':
    case 'raw':
      return Buffer.from(text, 'utf8')

    case 'proto-string':
      return encodeProtoWrappedString(text)

    case 'int64':
    case 'int32':
    case 'int16':
    case 'float64':
    case 'float32':
      return encodeNumber(text, spec.kind)

    case 'protobuf':
      if (!spec.protoSourceId || !spec.protoType) {
        throw new KlarityError(
          'SERDE_CONFIG',
          `No Protobuf type is configured for the ${target} of "${topic}".`,
          'Set it in the topic serde dialog, then produce again.'
        )
      }
      return encodeProtobuf(text, spec.protoSourceId, spec.protoType, spec.protoFile)

    case 'flatbuffers':
      if (!spec.fbsSchemaId) {
        throw new KlarityError(
          'SERDE_CONFIG',
          `No FlatBuffers schema is configured for the ${target} of "${topic}".`
        )
      }
      return encodeFlatBuffers(text, spec.fbsSchemaId, spec.fbsRootType)

    case 'avro-sr': {
      const registry = registryFor(clusterId)
      const subject = subjectFor(topic, target)
      const id = await registry.getLatestSchemaId(subject)
      return registry.encode(id, JSON.parse(text))
    }
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * ponytail: a producer per send. Connecting costs a round trip, which is
 * invisible next to a human pressing a button; the load-test engine (Phase 5)
 * owns a long-lived producer because it is the only path where it matters.
 */
async function withProducer<T>(clusterId: string, fn: (producer: Producer) => Promise<T>): Promise<T> {
  const producer = kafkaFor(clusterId).producer()
  await producer.connect()
  try {
    return await fn(producer)
  } finally {
    await producer.disconnect().catch((err: unknown) => {
      log.warn('Producer disconnect failed', err)
    })
  }
}

function toHeaders(headers: Record<string, string> | undefined): Record<string, Buffer> | undefined {
  if (!headers) return undefined
  const entries = Object.entries(headers).filter(([name]) => name.trim() !== '')
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries.map(([name, value]) => [name, Buffer.from(value, 'utf8')]))
}

/**
 * Record headers need message format v2 (Kafka 0.11). An older topic answers
 * any record carrying them with `UNKNOWN_SERVER_ERROR`, which tells the user
 * nothing — `p19-dev`'s topics are `0.10.1-IV2` and do exactly this. The extra
 * describeConfigs round trip is only paid on the failure path.
 */
async function explainHeaderRejection(
  err: unknown,
  clusterId: string,
  topic: string
): Promise<never> {
  try {
    const configs = await adminFor(clusterId).describeConfigs({
      includeSynonyms: false,
      resources: [{ type: ConfigResourceTypes.TOPIC, name: topic }]
    })
    const version = configs.resources[0]?.configEntries.find(
      (entry) => entry.configName === 'message.format.version'
    )?.configValue

    // "0.10.1-IV2", "2.8-IV1", "3.0" — anything starting 0.9/0.10 predates headers.
    if (version && /^0\.(9|10)/.test(version)) {
      throw new KlarityError(
        'INVALID_INPUT',
        `Topic "${topic}" cannot carry record headers.`,
        `Its message.format.version is ${version}; headers need 0.11 or newer. ` +
          'Send the message without headers, or raise the message format of the topic.'
      )
    }
  } catch (probeErr) {
    if (probeErr instanceof KlarityError) throw probeErr
    // Config lookup denied or failed: fall through to the original error.
  }
  throw err
}

async function send(
  clusterId: string,
  topic: string,
  message: { key: Buffer | null; value: Buffer; headers?: Record<string, Buffer>; partition?: number }
): Promise<ProduceResult> {
  const timestamp = Date.now()
  const [result] = await withProducer(clusterId, (producer) =>
    producer
      .send({
        topic,
        messages: [
          {
            key: message.key,
            value: message.value,
            headers: message.headers,
            ...(message.partition !== undefined ? { partition: message.partition } : {})
          }
        ]
      })
      .catch((err: unknown) =>
        message.headers ? explainHeaderRejection(err, clusterId, topic) : Promise.reject(err)
      )
  )

  if (!result) {
    throw new KlarityError('UNKNOWN', 'The broker acknowledged no partition for that message.')
  }

  return {
    topic,
    partition: result.partition,
    // baseOffset is the offset of the first (here: only) record in the batch.
    offset: result.baseOffset ?? '-1',
    timestamp: Number(result.logAppendTime ?? '-1') > 0 ? Number(result.logAppendTime) : timestamp
  }
}

export async function produceSingle(req: ProduceRequest): Promise<ProduceResult> {
  assertWritable(req.clusterId, 'Producing a message')
  if (!req.topic.trim()) throw invalid('Choose a topic to produce to.')

  const serde = getTopicSerde(req.clusterId, req.topic)
  const value = await encodeValue(req.value, serde.value, req.clusterId, req.topic, 'value')
  const key =
    req.key === undefined || req.key === ''
      ? null
      : await encodeValue(req.key, serde.key, req.clusterId, req.topic, 'key')

  const result = await send(req.clusterId, req.topic, {
    key,
    value,
    headers: toHeaders(req.headers),
    partition: req.partition
  })

  log.info(`Produced to ${req.topic} [${result.partition}] @ ${result.offset}`)
  return result
}

/**
 * Produce with a file as the key or the value. In `binary` mode the bytes go
 * out exactly as they are on disk — no serde, no re-encoding — which is what
 * makes the save-to-file / produce-from-file round trip byte-identical.
 */
export async function produceFromFile(req: ProduceFromFileRequest): Promise<ProduceResult> {
  assertWritable(req.clusterId, 'Producing a message')
  if (!req.topic.trim()) throw invalid('Choose a topic to produce to.')

  const stat = statSync(req.filePath)
  if (!stat.isFile()) throw invalid(`"${req.filePath}" is not a file.`)
  if (stat.size > MAX_FILE_BYTES) {
    throw invalid(
      `"${req.filePath}" is ${Math.round(stat.size / 1024 / 1024)} MB.`,
      `Klarity refuses to produce files over ${MAX_FILE_BYTES / 1024 / 1024} MB; ` +
        'brokers reject oversized records anyway.'
    )
  }

  const bytes = readFileSync(req.filePath)
  const serde = getTopicSerde(req.clusterId, req.topic)

  const fromFile =
    req.mode === 'binary'
      ? bytes
      : await encodeValue(
          bytes.toString('utf8'),
          req.target === 'key' ? serde.key : serde.value,
          req.clusterId,
          req.topic,
          req.target
        )

  const counterpartTarget = req.target === 'key' ? 'value' : 'key'
  const counterpart =
    req.counterpart === undefined || req.counterpart === ''
      ? null
      : await encodeValue(
          req.counterpart,
          counterpartTarget === 'key' ? serde.key : serde.value,
          req.clusterId,
          req.topic,
          counterpartTarget
        )

  if (req.target === 'value') {
    return send(req.clusterId, req.topic, {
      key: counterpart,
      value: fromFile,
      headers: toHeaders(req.headers),
      partition: req.partition
    })
  }

  if (!counterpart) {
    throw invalid(
      'A message needs a value.',
      'The file is being sent as the key, so type the value alongside it.'
    )
  }

  return send(req.clusterId, req.topic, {
    key: fromFile,
    value: counterpart,
    headers: toHeaders(req.headers),
    partition: req.partition
  })
}
