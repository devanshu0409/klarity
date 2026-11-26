/**
 * Neither codec package ships types. The surface we use is two functions each,
 * so declaring them here beats pulling in an untyped `any`.
 */

declare module 'kafkajs-snappy' {
  /** A codec *factory*, which is what kafkajs's CompressionCodecs map holds. */
  const codecFactory: () => {
    compress: (encoder: { buffer: Buffer }) => Promise<Buffer>
    decompress: (buffer: Buffer) => Promise<Buffer>
  }
  export default codecFactory
}

declare module 'lz4js' {
  const lz4: {
    compress: (input: Uint8Array) => Uint8Array
    decompress: (input: Uint8Array) => Uint8Array
  }
  export default lz4
}
