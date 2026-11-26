import kafkajs from 'kafkajs'
import SnappyCodec from 'kafkajs-snappy'
import lz4js from 'lz4js'
import { logger } from '../util/log'

const log = logger('compression')
const { CompressionCodecs, CompressionTypes } = kafkajs

/**
 * kafkajs only ships gzip. Everything else throws
 * `KafkaJSNotImplemented: <x> compression not implemented` mid-fetch, which
 * crashes the consumer rather than skipping the batch — a browser that cannot
 * read a Snappy topic is broken for most real clusters.
 *
 * Both codecs here are pure JavaScript on purpose: a native addon would drag
 * node-gyp and per-platform rebuilds into packaging.
 *
 * zstd is deliberately absent; the pure-JS options are WASM-sized and it is far
 * rarer in the wild. It still surfaces as a clear error rather than bad data.
 */
export function registerCompressionCodecs(): void {
  // kafkajs expects a *factory* that returns the codec. `kafkajs-snappy`
  // already exports that factory, so it is assigned directly — wrapping it in
  // another arrow hands kafkajs a function where it expects `{ decompress }`.
  CompressionCodecs[CompressionTypes.Snappy] = SnappyCodec

  CompressionCodecs[CompressionTypes.LZ4] = () => ({
    compress: (encoder: { buffer: Buffer }) =>
      Promise.resolve(Buffer.from(lz4js.compress(encoder.buffer))),
    decompress: (buffer: Buffer) => Promise.resolve(Buffer.from(lz4js.decompress(buffer)))
  })

  log.info('Registered snappy and lz4 compression codecs')
}
