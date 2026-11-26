import { describe, expect, it } from 'vitest'
import { decodeHeaders, decodeSync } from '../src/main/serde/decode'

/**
 * The byte patterns here are real records off `asset-feed` on p19-dev: a Java
 * producer writing the key with `LongSerializer` and the `CUSTOMER_ID` header
 * the same way. Both are valid UTF-8 — which is precisely why they used to
 * render as invisible control characters instead of numbers.
 */
const LONG_KEY = Buffer.from('0000000000343e64', 'hex') // 3,423,844
const LONG_HEADER = Buffer.from('0000000000030010', 'hex') // 196,624

const auto = { kind: 'auto' } as const

describe('fixed-width numeric serdes', () => {
  it('decodes an explicit Long key', () => {
    const out = decodeSync(LONG_KEY, { kind: 'int64' })
    expect(out.format).toBe('number')
    expect(out.text).toBe('3423844')
  })

  it('auto-detects an 8-byte key as a Long rather than showing control characters', () => {
    const out = decodeSync(LONG_KEY, auto)
    expect(out.format).toBe('number')
    expect(out.text).toBe('3423844')
  })

  it('auto-detects a 4-byte Integer', () => {
    expect(decodeSync(Buffer.from('0001e240', 'hex'), auto).text).toBe('123456')
  })

  it('does not guess on bytes that are not obviously a number', () => {
    // High byte set: arbitrary binary, not a small id.
    expect(decodeSync(Buffer.from('fffe0001', 'hex'), auto).format).toBe('raw')
    // Two bytes carry too little signal to guess from.
    expect(decodeSync(Buffer.from('01f4', 'hex'), auto).format).toBe('raw')
    // Explicit still works.
    expect(decodeSync(Buffer.from('01f4', 'hex'), { kind: 'int16' }).text).toBe('500')
  })

  it('keeps a Java long past 2^53 exact', () => {
    const buffer = Buffer.alloc(8)
    buffer.writeBigInt64BE(9007199254740993n, 0)
    expect(decodeSync(buffer, { kind: 'int64' }).text).toBe('9007199254740993')
  })

  it('reads doubles and floats when asked explicitly', () => {
    const double = Buffer.alloc(8)
    double.writeDoubleBE(12.5, 0)
    expect(decodeSync(double, { kind: 'float64' }).text).toBe('12.5')

    const float = Buffer.alloc(4)
    float.writeFloatBE(0.5, 0)
    expect(decodeSync(float, { kind: 'float32' }).text).toBe('0.5')
  })

  it('reports a width mismatch instead of decoding garbage', () => {
    const out = decodeSync(Buffer.from('abc'), { kind: 'int64' })
    expect(out.format).toBe('raw')
    expect(out.decodeError).toMatch(/8 bytes; this one is 3/)
  })

  it('still prefers readable text over a number guess', () => {
    // 8 printable bytes: a text key, not a Long.
    expect(decodeSync(Buffer.from('ORDER-42'), auto).format).toBe('string')
    // 4 printable bytes.
    expect(decodeSync(Buffer.from('abcd'), auto).format).toBe('string')
  })

  it('renders a numeric header as its number, not control characters', () => {
    const headers = decodeHeaders({
      SOURCE: Buffer.from('HDS_CLOUD_VIEW'),
      CUSTOMER_ID: LONG_HEADER,
      ASSET_CREATED: Buffer.from('false')
    })
    expect(headers.SOURCE).toBe('HDS_CLOUD_VIEW')
    expect(headers.CUSTOMER_ID).toBe('196624')
    expect(headers.ASSET_CREATED).toBe('false')
  })

  it('falls back to hex for header bytes that are neither text nor a known width', () => {
    expect(decodeHeaders({ BLOB: Buffer.from('00ff01', 'hex') }).BLOB).toBe('00ff01')
  })
})

describe('repeated headers', () => {
  it('keeps every value when a header name repeats', () => {
    const values = [Buffer.from('00000001', 'hex'), Buffer.from('00000002', 'hex')]
    expect(decodeHeaders({ TRACE: values }).TRACE).toBe('1, 2')
  })
})
