import { SchemaRegistry } from '@kafkajs/confluent-schema-registry'
import { KlarityError } from '../util/errors'
import { logger } from '../util/log'
import { getProfile, getSecrets } from '../store/profiles'

const log = logger('registry')

/** One registry client per cluster; schema lookups are cached inside it. */
const clients = new Map<string, SchemaRegistry>()

export function registryFor(clusterId: string): SchemaRegistry {
  const existing = clients.get(clusterId)
  if (existing) return existing

  const profile = getProfile(clusterId)
  if (!profile.schemaRegistry.enabled) {
    throw new KlarityError(
      'SERDE_CONFIG',
      'Schema Registry is not enabled for this cluster.',
      'Turn it on in the cluster settings and provide the registry URL.'
    )
  }

  const { registryPassword } = getSecrets(clusterId)
  const client = new SchemaRegistry({
    host: profile.schemaRegistry.url,
    ...(profile.schemaRegistry.username
      ? {
          auth: {
            username: profile.schemaRegistry.username,
            password: registryPassword ?? ''
          }
        }
      : {})
  })

  clients.set(clusterId, client)
  log.info(`Schema Registry client ready for "${profile.name}"`)
  return client
}

export function invalidateRegistry(clusterId?: string): void {
  if (clusterId) clients.delete(clusterId)
  else clients.clear()
}

/**
 * Confluent wire format: a zero magic byte, then a 4-byte big-endian schema id,
 * then the encoded payload. The registry client handles Avro, Protobuf and
 * JSON Schema behind the same envelope.
 */
export function readSchemaId(buffer: Buffer): number | null {
  if (buffer.length < 5 || buffer[0] !== 0x00) return null
  return buffer.readUInt32BE(1)
}

export async function decodeRegistryPayload(
  buffer: Buffer,
  clusterId: string
): Promise<string> {
  const decoded: unknown = await registryFor(clusterId).decode(buffer)
  // Avro logical types come back as Buffers/BigInts that JSON.stringify chokes
  // on, so normalise before serialising.
  return JSON.stringify(decoded, replacer, 2)
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Buffer) return value.toString('base64')
  return value
}
