import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import protobuf from 'protobufjs'
import { decodeProtobuf, encodeProtobuf, invalidateProtoCache } from '../src/main/serde/protobuf'
import { upsertProtoSource } from '../src/main/store/schemaStore'

// The store writes into Electron's userData; point it at a temp dir instead.
const dataDir = mkdtempSync(join(tmpdir(), 'klarity-test-'))
vi.mock('electron', () => ({
  app: { getPath: () => dataDir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const SCHEMA = `
syntax = "proto3";
package acme.orders.v1;

message Order {
  string id = 1;
  int64 total_cents = 2;
  repeated string items = 3;
  Status status = 4;
}

enum Status {
  UNKNOWN = 0;
  PAID = 1;
}
`

let protoDir: string
let sourceId: string

beforeAll(() => {
  protoDir = mkdtempSync(join(tmpdir(), 'klarity-proto-'))
  writeFileSync(join(protoDir, 'order.proto'), SCHEMA, 'utf8')

  // Register the source directly, then let the decoder parse it on demand.
  const root = new protobuf.Root()
  root.loadSync(join(protoDir, 'order.proto'), { keepCase: true })
  root.resolveAll()

  sourceId = upsertProtoSource({
    name: 'test',
    dir: protoDir,
    types: [{ fullName: 'acme.orders.v1.Order', file: 'order.proto', fieldCount: 4 }]
  }).id
})

afterAll(() => {
  invalidateProtoCache()
  rmSync(protoDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

describe('protobuf serde', () => {
  it('round-trips a message', () => {
    const json = JSON.stringify({
      id: 'A-1',
      total_cents: '1999',
      items: ['sku-1', 'sku-2'],
      status: 'PAID'
    })

    const bytes = encodeProtobuf(json, sourceId, 'acme.orders.v1.Order')
    const decoded = JSON.parse(decodeProtobuf(bytes, sourceId, 'acme.orders.v1.Order'))

    expect(decoded.id).toBe('A-1')
    expect(decoded.items).toEqual(['sku-1', 'sku-2'])
    expect(decoded.status).toBe('PAID')
  })

  it('keeps int64 as a string so precision survives', () => {
    // 2^53 + 1 would round if it went through a JS number.
    const json = JSON.stringify({ id: 'big', total_cents: '9007199254740993' })
    const bytes = encodeProtobuf(json, sourceId, 'acme.orders.v1.Order')
    const decoded = JSON.parse(decodeProtobuf(bytes, sourceId, 'acme.orders.v1.Order'))
    expect(decoded.total_cents).toBe('9007199254740993')
  })

  it('fills defaults so the full shape is visible', () => {
    const bytes = encodeProtobuf(JSON.stringify({ id: 'x' }), sourceId, 'acme.orders.v1.Order')
    const decoded = JSON.parse(decodeProtobuf(bytes, sourceId, 'acme.orders.v1.Order'))
    expect(decoded.items).toEqual([])
    expect(decoded.total_cents).toBe('0')
  })

  it('rejects a document that does not match the type', () => {
    // protobufjs coerces scalars (42 -> "42"), so the check uses a shape it
    // genuinely cannot convert.
    expect(() =>
      encodeProtobuf(JSON.stringify({ items: 'not-a-list' }), sourceId, 'acme.orders.v1.Order')
    ).toThrow(/does not match/)
  })

  it('reports an unknown message type clearly', () => {
    expect(() => decodeProtobuf(Buffer.from([]), sourceId, 'acme.orders.v1.Nope')).toThrow(
      /not in that \.proto source/
    )
  })
})
