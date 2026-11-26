import { describe, expect, it } from 'vitest'
import { decodeHeaders, decodeSync } from '../src/main/serde/decode'

const auto = { kind: 'auto' } as const

describe('decode', () => {
  it('reports null payloads distinctly from empty ones', () => {
    expect(decodeSync(null, auto).format).toBe('null')
  })

  it('pretty-prints JSON', () => {
    const out = decodeSync(Buffer.from('{"a":1}'), auto)
    expect(out.format).toBe('json')
    expect(out.text).toBe('{\n  "a": 1\n}')
  })

  it('leaves plain text as a string', () => {
    const out = decodeSync(Buffer.from('hello world'), auto)
    expect(out.format).toBe('string')
    expect(out.text).toBe('hello world')
  })

  it('does not treat a bare number as JSON', () => {
    // JSON.parse('42') succeeds, but showing a scalar as a "JSON document"
    // misrepresents what is on the topic.
    expect(decodeSync(Buffer.from('42'), auto).format).toBe('string')
  })

  it('falls back to raw for binary payloads', () => {
    const out = decodeSync(Buffer.from([0xff, 0xfe, 0x00, 0x01]), auto)
    expect(out.format).toBe('raw')
    expect(out.rawBase64).toBeDefined()
  })

  it('flags Schema Registry framing instead of dumping hex', () => {
    const buffer = Buffer.concat([
      Buffer.from([0x00]),
      Buffer.from([0x00, 0x00, 0x00, 0x2a]), // schema id 42
      Buffer.from([0x10, 0x20])
    ])
    const out = decodeSync(buffer, auto)
    expect(out.schemaId).toBe(42)
    expect(out.decodeError).toContain('42')
  })

  it('reports invalid JSON when JSON was demanded explicitly', () => {
    const out = decodeSync(Buffer.from('not json'), { kind: 'json' })
    expect(out.decodeError).toContain('Not valid JSON')
    expect(out.text).toBe('not json')
  })

  it('never throws on an unsupported serde', () => {
    const out = decodeSync(Buffer.from('x'), { kind: 'protobuf', protoType: 'a.B' })
    expect(out.format).toBe('raw')
    expect(out.decodeError).toBeDefined()
  })
})

/** Encodes `field 1 = <text>` — the wire form of google.protobuf.StringValue. */
function protoWrap(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const header: number[] = [0x0a]
  let length = payload.length
  do {
    let byte = length & 0x7f
    length >>>= 7
    if (length > 0) byte |= 0x80
    header.push(byte)
  } while (length > 0)
  return Buffer.concat([Buffer.from(header), payload])
}

describe('protobuf-wrapped strings', () => {
  it('unwraps a StringValue-style key', () => {
    const out = decodeSync(protoWrap('asset-4f21'), { kind: 'proto-string' })
    expect(out.format).toBe('string')
    expect(out.text).toBe('asset-4f21')
  })

  it('handles payloads long enough to need a multi-byte length', () => {
    const long = 'x'.repeat(300)
    expect(decodeSync(protoWrap(long), { kind: 'proto-string' }).text).toBe(long)
  })

  it('auto-detects the wrapper instead of rendering mojibake', () => {
    // Read as plain text these bytes are a newline, a control byte, then the
    // value — which is what made these keys unreadable.
    const out = decodeSync(protoWrap('uuid-1'), auto)
    expect(out.format).toBe('string')
    expect(out.text).toBe('uuid-1')
  })

  it('leaves a real multi-field message alone', () => {
    // field 1 = "a", then field 2 = 1: not a bare wrapper, so auto must not
    // strip it down to the first string.
    const message = Buffer.concat([protoWrap('a'), Buffer.from([0x10, 0x01])])
    expect(decodeSync(message, { kind: 'proto-string' }).decodeError).toContain(
      'Not a protobuf-wrapped string'
    )
  })

  it('rejects a wrapper whose payload is not valid UTF-8', () => {
    const binary = Buffer.concat([Buffer.from([0x0a, 0x02]), Buffer.from([0xff, 0xfe])])
    expect(decodeSync(binary, { kind: 'proto-string' }).decodeError).toBeDefined()
  })

  it('still treats ordinary text as text', () => {
    expect(decodeSync(Buffer.from('plain-key'), auto).text).toBe('plain-key')
  })
})

describe('decodeHeaders', () => {
  it('renders text headers as text and binary ones as hex', () => {
    expect(
      decodeHeaders({
        trace: Buffer.from('abc'),
        blob: Buffer.from([0xff, 0x00])
      })
    ).toEqual({ trace: 'abc', blob: 'ff00' })
  })

  it('tolerates missing headers', () => {
    expect(decodeHeaders(undefined)).toEqual({})
  })
})
