import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import AdmZip from 'adm-zip'
import protobuf from 'protobufjs'
import descriptorExt from 'protobufjs/ext/descriptor.js'
import { findDescriptorCandidates, readUtf8Constants } from '../src/main/serde/javaClass'
import { descriptorToProto } from '../src/main/serde/descriptorToProto'
import { importProtosFromJars } from '../src/main/serde/jarImport'

const dataDir = mkdtempSync(join(tmpdir(), 'klarity-jar-'))
vi.mock('electron', () => ({
  app: { getPath: () => dataDir },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {}
}))

afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

const SCHEMA = `
syntax = "proto3";
package acme.orders.v1;

message Order {
  string id = 1;
  int64 total_cents = 2;
  repeated string items = 3;
  Status status = 4;
  map<string, string> labels = 5;
  Address ship_to = 6;

  message Address {
    string city = 1;
  }
}

enum Status {
  UNKNOWN = 0;
  PAID = 1;
}
`

/** Builds the serialized FileDescriptorProto for the schema above. */
function buildDescriptorBytes(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'klarity-proto-src-'))
  try {
    const file = join(dir, 'order.proto')
    require('node:fs').writeFileSync(file, SCHEMA, 'utf8')
    const root = new protobuf.Root()
    root.loadSync(file, { keepCase: true })
    root.resolveAll()

    // toDescriptor yields a FileDescriptorSet; protoc embeds a single file.
    const set = (
      root as unknown as { toDescriptor: (syntax: string) => { toJSON: () => unknown } }
    ).toDescriptor('proto3')
    const json = set.toJSON() as { file: Record<string, unknown>[] }
    const fileProto = { ...json.file[0], name: 'acme/orders/v1/order.proto', syntax: 'proto3' }

    const types = descriptorExt as unknown as {
      FileDescriptorProto: {
        fromObject: (o: unknown) => unknown
        encode: (m: unknown) => { finish: () => Uint8Array }
      }
    }
    return Buffer.from(
      types.FileDescriptorProto.encode(types.FileDescriptorProto.fromObject(fileProto)).finish()
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Encodes a string as Java's modified UTF-8 — the encoding protoc's generated
 * classes use for the embedded descriptor literal.
 */
function encodeModifiedUtf8(chars: number[]): Buffer {
  const out: number[] = []
  for (const code of chars) {
    if (code === 0) out.push(0xc0, 0x80)
    else if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
  }
  return Buffer.from(out)
}

/**
 * Synthesises a minimal `.class` file whose constant pool carries the
 * descriptor bytes, mirroring how protoc's Java output stores them.
 */
function buildClassFile(descriptor: Buffer): Buffer {
  const chars = [...descriptor].map((b) => b)
  const payload = encodeModifiedUtf8(chars)
  const decoy = Buffer.from('java/lang/Object', 'utf8')

  const parts: Buffer[] = []
  const header = Buffer.alloc(10)
  header.writeUInt32BE(0xcafebabe, 0)
  header.writeUInt16BE(0, 4) // minor
  header.writeUInt16BE(61, 6) // major
  header.writeUInt16BE(5, 8) // constant_pool_count (4 real entries)
  parts.push(header)

  // #1 Utf8: an ordinary class-name string, to prove the scan skips noise
  const one = Buffer.alloc(3)
  one.writeUInt8(1, 0)
  one.writeUInt16BE(decoy.length, 1)
  parts.push(one, decoy)

  // #2 Long: occupies two slots — the walker must skip the extra index
  const two = Buffer.alloc(9)
  two.writeUInt8(5, 0)
  two.writeBigUInt64BE(42n, 1)
  parts.push(two)

  // #4 Utf8: the descriptor literal
  const four = Buffer.alloc(3)
  four.writeUInt8(1, 0)
  four.writeUInt16BE(payload.length, 1)
  parts.push(four, payload)

  return Buffer.concat(parts)
}

describe('java class descriptor recovery', () => {
  const descriptor = buildDescriptorBytes()
  const classFile = buildClassFile(descriptor)

  it('walks the constant pool past multi-slot entries', () => {
    const constants = readUtf8Constants(classFile)
    expect(constants[0]).toBe('java/lang/Object')
    // The Long at #2 consumes two slots; if that were mishandled the descriptor
    // literal would be missed entirely.
    expect(constants).toHaveLength(2)
  })

  it('recovers the exact descriptor bytes', () => {
    const [candidate] = findDescriptorCandidates(classFile)
    expect(candidate).toBeDefined()
    expect(Buffer.compare(candidate, descriptor)).toBe(0)
  })
})

describe('descriptorToProto', () => {
  it('renders a schema that protobufjs can parse back', () => {
    const descriptor = buildDescriptorBytes()
    const types = descriptorExt as unknown as {
      FileDescriptorProto: { decode: (b: Buffer) => { toJSON: () => unknown } }
    }
    const file = types.FileDescriptorProto.decode(descriptor).toJSON()
    const text = descriptorToProto(file as never)

    expect(text).toContain('syntax = "proto3"')
    expect(text).toContain('package acme.orders.v1;')
    expect(text).toContain('repeated string items = 3;')
    // Map fields must render as sugar, not as the synthetic entry message.
    expect(text).toContain('map<string, string> labels = 5;')
    expect(text).not.toContain('LabelsEntry')
    expect(text).toContain('enum Status')
    expect(text).toContain('message Address')

    // The real proof: the rendered text round-trips through a proto parser.
    const dir = mkdtempSync(join(tmpdir(), 'klarity-rendered-'))
    try {
      const file = join(dir, 'order.proto')
      require('node:fs').writeFileSync(file, text, 'utf8')
      const root = new protobuf.Root()
      root.loadSync(file, { keepCase: true })
      root.resolveAll()
      const type = root.lookupType('acme.orders.v1.Order')
      expect(type.fieldsArray.length).toBeGreaterThanOrEqual(6)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('importProtosFromJars', () => {
  it('extracts schemas from compiled classes inside a jar', () => {
    const descriptor = buildDescriptorBytes()
    const zip = new AdmZip()
    zip.addFile('acme/orders/v1/OrderOuterClass.class', buildClassFile(descriptor))
    zip.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\n'))

    const jarDir = mkdtempSync(join(tmpdir(), 'klarity-jarfile-'))
    const jarPath = join(jarDir, 'orders.jar')
    zip.writeZip(jarPath)

    const outDir = join(dataDir, 'out-classes')
    try {
      const result = importProtosFromJars([jarPath], outDir)
      expect(result.files).toHaveLength(1)
      expect(result.files[0].path).toBe('acme/orders/v1/order.proto')
      expect(result.files[0].origin).toBe('class')

      const written = readFileSync(join(outDir, 'acme/orders/v1/order.proto'), 'utf8')
      expect(written).toContain('message Order')
    } finally {
      rmSync(jarDir, { recursive: true, force: true })
    }
  })

  it('prefers a real .proto shipped in the jar over a reconstructed one', () => {
    const descriptor = buildDescriptorBytes()
    const zip = new AdmZip()
    zip.addFile('acme/orders/v1/OrderOuterClass.class', buildClassFile(descriptor))
    zip.addFile('acme/orders/v1/order.proto', Buffer.from('// original source\n', 'utf8'))

    const jarDir = mkdtempSync(join(tmpdir(), 'klarity-jarfile2-'))
    const jarPath = join(jarDir, 'orders-with-src.jar')
    zip.writeZip(jarPath)

    const outDir = join(dataDir, 'out-prefer-proto')
    try {
      const result = importProtosFromJars([jarPath], outDir)
      const entry = result.files.find((f) => f.path === 'acme/orders/v1/order.proto')
      expect(entry?.origin).toBe('proto')
      expect(readFileSync(join(outDir, 'acme/orders/v1/order.proto'), 'utf8')).toContain(
        'original source'
      )
    } finally {
      rmSync(jarDir, { recursive: true, force: true })
    }
  })

  it('writes into the destination folder it is given, once', () => {
    const descriptor = buildDescriptorBytes()
    const zip = new AdmZip()
    zip.addFile('acme/orders/v1/OrderOuterClass.class', buildClassFile(descriptor))

    const jarDir = mkdtempSync(join(tmpdir(), 'klarity-jardest-'))
    const jarPath = join(jarDir, 'orders.jar')
    zip.writeZip(jarPath)

    // A folder the caller supplies, not one the app invents.
    const chosen = mkdtempSync(join(tmpdir(), 'klarity-chosen-'))
    try {
      const first = importProtosFromJars([jarPath], chosen)
      expect(first.outDir).toBe(chosen)

      const target = join(chosen, 'acme/orders/v1/order.proto')
      const written = readFileSync(target, 'utf8')
      expect(written).toContain('message Order')

      // Re-importing overwrites in place rather than accumulating copies.
      const second = importProtosFromJars([jarPath], chosen)
      expect(second.files).toHaveLength(1)
      expect(readFileSync(target, 'utf8')).toBe(written)
    } finally {
      rmSync(jarDir, { recursive: true, force: true })
      rmSync(chosen, { recursive: true, force: true })
    }
  })

  it('recurses into nested jars, as fat jars require', () => {
    const descriptor = buildDescriptorBytes()
    const inner = new AdmZip()
    inner.addFile('acme/orders/v1/OrderOuterClass.class', buildClassFile(descriptor))

    const outer = new AdmZip()
    outer.addFile('BOOT-INF/lib/orders.jar', inner.toBuffer())

    const jarDir = mkdtempSync(join(tmpdir(), 'klarity-fatjar-'))
    const jarPath = join(jarDir, 'app.jar')
    outer.writeZip(jarPath)

    const outDir = join(dataDir, 'out-nested')
    try {
      const result = importProtosFromJars([jarPath], outDir)
      expect(result.files).toHaveLength(1)
      expect(result.files[0].source).toContain('BOOT-INF/lib/orders.jar')
    } finally {
      rmSync(jarDir, { recursive: true, force: true })
    }
  })
})
