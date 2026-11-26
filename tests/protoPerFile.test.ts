import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const dataDir = mkdtempSync(join(tmpdir(), 'klarity-perfile-'))
vi.mock('electron', () => ({
  app: { getPath: () => dataDir },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {}
}))

const { loadProtoSource, decodeProtobuf, encodeProtobuf, invalidateProtoCache } = await import(
  '../src/main/serde/protobuf'
)

afterAll(() => {
  invalidateProtoCache()
  rmSync(dataDir, { recursive: true, force: true })
})

/**
 * Reproduces a real schema jar: no `package` anywhere, and two files that each
 * declare a top-level `Service`. protoc compiled them as separate units, so
 * this is valid — but a single protobufjs root rejects it with
 * "duplicate name 'Service' in Root".
 */
function writeSchema(): string {
  const dir = mkdtempSync(join(tmpdir(), 'klarity-nopkg-'))
  writeFileSync(
    join(dir, 'ports.proto'),
    `syntax = "proto3";
message Service {
  string name = 1;
  string transport = 2;
}
`,
    'utf8'
  )
  writeFileSync(
    join(dir, 'service.proto'),
    `syntax = "proto3";
message Service {
  string description = 1;
  string state = 2;
}
`,
    'utf8'
  )
  // A file that loads cleanly on its own, to prove unaffected files still work.
  mkdirSync(join(dir, 'nested'), { recursive: true })
  writeFileSync(
    join(dir, 'nested', 'other.proto'),
    `syntax = "proto3";
message Other { int64 count = 1; }
`,
    'utf8'
  )
  return dir
}

describe('package-less schemas with colliding type names', () => {
  const dir = writeSchema()
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const source = loadProtoSource('nopkg', dir)

  it('loads instead of failing outright', () => {
    expect(source.error).toBeUndefined()
    expect(source.types.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps both Service types, distinguished by file', () => {
    const services = source.types.filter((t) => t.fullName === 'Service')
    expect(services.map((s) => s.file).sort()).toEqual(['ports.proto', 'service.proto'])
  })

  it('decodes against the file the user picked, not whichever sorts first', () => {
    // Field 1 is `name` in ports.proto but `description` in service.proto, so
    // the same bytes must decode differently depending on the chosen file.
    const bytes = encodeProtobuf(
      JSON.stringify({ name: 'ssh' }),
      source.id,
      'Service',
      'ports.proto'
    )

    const asPorts = JSON.parse(decodeProtobuf(bytes, source.id, 'Service', 'ports.proto'))
    expect(asPorts.name).toBe('ssh')

    const asService = JSON.parse(decodeProtobuf(bytes, source.id, 'Service', 'service.proto'))
    expect(asService.description).toBe('ssh')
  })

  it('refuses an ambiguous lookup rather than guessing a file', () => {
    expect(() => decodeProtobuf(Buffer.alloc(0), source.id, 'Service')).toThrow(
      /declared in 2 files/
    )
  })

  it('still resolves an unambiguous type without a file', () => {
    const bytes = encodeProtobuf(JSON.stringify({ count: '7' }), source.id, 'Other')
    expect(JSON.parse(decodeProtobuf(bytes, source.id, 'Other')).count).toBe('7')
  })
})
