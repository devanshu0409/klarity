import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The store writes into Electron's userData; point it at a temp dir instead.
const dataDir = mkdtempSync(join(tmpdir(), 'klarity-test-'))
vi.mock('electron', () => ({
  app: { getPath: () => dataDir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const { encodeValue } = await import('../src/main/kafka/producer')
const { decodeSync } = await import('../src/main/serde/decode')
const { upsertProtoSource } = await import('../src/main/store/schemaStore')
const { invalidateProtoCache } = await import('../src/main/serde/protobuf')

const SCHEMA = `
syntax = "proto3";
package acme.orders.v1;

message Order {
  string id = 1;
  int64 total_cents = 2;
  repeated string items = 3;
}
`

let sourceDir: string

beforeAll(() => {
  sourceDir = mkdtempSync(join(tmpdir(), 'klarity-proto-'))
  writeFileSync(join(sourceDir, 'order.proto'), SCHEMA, 'utf8')
  upsertProtoSource({
    id: 'src-1',
    name: 'orders',
    dir: sourceDir,
    types: [{ fullName: 'acme.orders.v1.Order', file: 'order.proto', fieldCount: 3 }],
    loadedAt: Date.now()
  })
  invalidateProtoCache()
})

afterAll(() => {
  rmSync(sourceDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

describe('encodeValue', () => {
  it('sends text formats as UTF-8', async () => {
    for (const kind of ['auto', 'json', 'string', 'raw'] as const) {
      const bytes = await encodeValue('{"a":1}', { kind }, 'cluster', 'topic', 'value')
      expect(bytes.toString('utf8')).toBe('{"a":1}')
    }
  })

  it('wraps a proto-string the way the decoder unwraps it', async () => {
    const bytes = await encodeValue('order-42', { kind: 'proto-string' }, 'c', 't', 'key')
    expect(bytes[0]).toBe(0x0a)
    expect(bytes[1]).toBe(8)
    expect(decodeSync(bytes, { kind: 'proto-string' }).text).toBe('order-42')
  })

  it('uses a two-byte varint length past 127 bytes', async () => {
    const long = 'x'.repeat(300)
    const bytes = await encodeValue(long, { kind: 'proto-string' }, 'c', 't', 'key')
    // 300 = 0b100101100 -> 0xAC 0x02 little-endian base 128.
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0x0a, 0xac, 0x02])
    expect(decodeSync(bytes, { kind: 'proto-string' }).text).toBe(long)
  })

  it('round-trips a Protobuf message through encode and decode', async () => {
    const spec = {
      kind: 'protobuf' as const,
      protoSourceId: 'src-1',
      protoType: 'acme.orders.v1.Order',
      protoFile: 'order.proto'
    }
    // protobufjs keys objects by the declared field name, not camelCase.
    const json = JSON.stringify({ id: 'o-1', total_cents: '9007199254740993', items: ['a', 'b'] })

    const bytes = await encodeValue(json, spec, 'cluster', 'orders', 'value')
    const decoded = decodeSync(bytes, spec)

    expect(decoded.format).toBe('protobuf')
    expect(decoded.decodeError).toBeUndefined()
    const parsed = JSON.parse(decoded.text) as Record<string, unknown>
    expect(parsed.id).toBe('o-1')
    expect(parsed.items).toEqual(['a', 'b'])
    // int64 survives as a string; going through Number would lose the last digit.
    expect(parsed.total_cents).toBe('9007199254740993')
  })

  it('rejects an object handed to a scalar field instead of sending "[object Object]"', async () => {
    await expect(
      encodeValue('{"id": {"nested": true}}', {
        kind: 'protobuf',
        protoSourceId: 'src-1',
        protoType: 'acme.orders.v1.Order',
        protoFile: 'order.proto'
      }, 'cluster', 'orders', 'value')
    ).rejects.toThrow(/is a string, but the value is an object/)
  })

  it('rejects a misspelled field instead of dropping it', async () => {
    await expect(
      encodeValue(
        '{"id": "o-1", "totalCents": "5"}',
        {
          kind: 'protobuf',
          protoSourceId: 'src-1',
          protoType: 'acme.orders.v1.Order',
          protoFile: 'order.proto'
        },
        'cluster',
        'orders',
        'value'
      )
    ).rejects.toThrow(/"totalCents" is not a field/)
  })

  it('refuses a Protobuf spec with no type configured', async () => {
    await expect(
      encodeValue('{}', { kind: 'protobuf' }, 'cluster', 'orders', 'value')
    ).rejects.toThrow(/No Protobuf type/)
  })
})
