// The low-level half of pako (a JavaScript port of zlib), which keeps zlib's z_stream API.

declare module 'pako/lib/zlib/zstream.js' {
  export default class ZStream {
    input: Uint8Array | null
    next_in: number
    avail_in: number
    total_in: number
    output: Uint8Array | null
    next_out: number
    avail_out: number
    total_out: number
    msg: string
    state: unknown
  }
}

declare module 'pako/lib/zlib/deflate.js' {
  import type ZStream from 'pako/lib/zlib/zstream.js'
  const deflate: {
    deflateInit2(strm: ZStream, level: number, method: number, windowBits: number, memLevel: number, strategy: number): number
    deflate(strm: ZStream, flush: number): number
    deflateEnd(strm: ZStream): number
    deflateReset(strm: ZStream): number
    deflateSetDictionary(strm: ZStream, dictionary: Uint8Array): number
  }
  export default deflate
}

declare module 'pako/lib/zlib/inflate.js' {
  import type ZStream from 'pako/lib/zlib/zstream.js'
  const inflate: {
    inflateInit2(strm: ZStream, windowBits: number): number
    inflate(strm: ZStream, flush: number): number
    inflateEnd(strm: ZStream): number
    inflateReset(strm: ZStream): number
    inflateSetDictionary(strm: ZStream, dictionary: Uint8Array): number
  }
  export default inflate
}

declare module 'pako/lib/zlib/crc32.js' {
  export default function crc32(crc: number, buf: Uint8Array, len: number, pos: number): number
}
