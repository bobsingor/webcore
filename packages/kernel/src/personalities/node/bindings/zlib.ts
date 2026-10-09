// zlib (src/node_zlib.cc) over pako, a JavaScript port of zlib that keeps zlib's z_stream API:
// Node's write(flush, in, in_off, in_len, out, out_off, out_len) maps onto it field for field, and
// error messages ("incorrect header check") are zlib's own. Asynchronous writes run on a later
// macrotask instead of the thread pool. Brotli and zstd aren't available yet.
import pakoCrc32 from 'pako/lib/zlib/crc32.js'
import pakoDeflate from 'pako/lib/zlib/deflate.js'
import pakoInflate from 'pako/lib/zlib/inflate.js'
import ZStream from 'pako/lib/zlib/zstream.js'
import { bytesOf, encode } from '../codec.ts'
import type { Realm } from '../realm.ts'

// node_zlib_mode
const DEFLATE = 1
const INFLATE = 2
const GZIP = 3
const GUNZIP = 4
const DEFLATERAW = 5
const INFLATERAW = 6
const UNZIP = 7

const Z_OK = 0
const Z_STREAM_END = 1
const Z_NEED_DICT = 2
const Z_DATA_ERROR = -3
const Z_BUF_ERROR = -5
const Z_FINISH = 4
const Z_DEFLATED = 8
const GZIP_HEADER_ID1 = 0x1f
const GZIP_HEADER_ID2 = 0x8b

const ERROR_CODES: Record<number, string> = {
  [Z_OK]: 'Z_OK',
  [Z_STREAM_END]: 'Z_STREAM_END',
  [Z_NEED_DICT]: 'Z_NEED_DICT',
  [-1]: 'Z_ERRNO',
  [-2]: 'Z_STREAM_ERROR',
  [Z_DATA_ERROR]: 'Z_DATA_ERROR',
  [-4]: 'Z_MEM_ERROR',
  [Z_BUF_ERROR]: 'Z_BUF_ERROR',
  [-6]: 'Z_VERSION_ERROR',
}

interface CompressionError {
  message: string
  code: string
  err: number
}

/** ZlibContext: one z_stream and the mode-specific steps around it. */
class ZlibContext {
  mode: number
  private level = 0
  private windowBits = 0
  private memLevel = 0
  private strategy = 0
  private dictionary?: Uint8Array
  private rejectGarbageAfterEnd = false
  private strm = new ZStream()
  private initDone = false
  private gzipIdBytesRead = 0
  err = Z_OK
  flush = 0

  constructor(mode: number) {
    this.mode = mode
  }

  init(level: number, windowBits: number, memLevel: number, strategy: number, rejectGarbage: boolean, dictionary?: Uint8Array) {
    this.level = level
    this.memLevel = memLevel
    this.strategy = strategy
    this.rejectGarbageAfterEnd = rejectGarbage
    this.dictionary = dictionary?.length ? dictionary : undefined
    this.windowBits = windowBits
    if (this.mode === GZIP || this.mode === GUNZIP) this.windowBits += 16
    if (this.mode === UNZIP) this.windowBits += 32
    if (this.mode === DEFLATERAW || this.mode === INFLATERAW) this.windowBits *= -1
  }

  setBuffers(input: Uint8Array, inOff: number, inLen: number, output: Uint8Array, outOff: number, outLen: number) {
    this.strm.input = input
    this.strm.next_in = inOff
    this.strm.avail_in = inLen
    this.strm.output = output
    this.strm.next_out = outOff
    this.strm.avail_out = outLen
  }

  get availIn() {
    return this.strm.avail_in
  }

  get availOut() {
    return this.strm.avail_out
  }

  /** DoThreadPoolWork. */
  work(): void {
    if (this.initZlib() && this.err !== Z_OK) return
    const strm = this.strm
    if (this.mode === DEFLATE || this.mode === GZIP || this.mode === DEFLATERAW) {
      this.err = pakoDeflate.deflate(strm, this.flush)
      return
    }
    if (this.mode === UNZIP) this.detectGzip()
    this.err = pakoInflate.inflate(strm, this.flush)
    if (this.mode !== INFLATERAW && this.err === Z_NEED_DICT && this.dictionary) {
      this.err = pakoInflate.inflateSetDictionary(strm, this.dictionary)
      if (this.err === Z_OK) this.err = pakoInflate.inflate(strm, this.flush)
      else if (this.err === Z_DATA_ERROR) this.err = Z_NEED_DICT
    }
    // Another gzip member may follow; trailing zero bytes are padding.
    while (
      strm.avail_in > 0 &&
      this.mode === GUNZIP &&
      this.err === Z_STREAM_END &&
      !this.rejectGarbageAfterEnd &&
      strm.input![strm.next_in] !== 0
    ) {
      this.resetStream()
      this.err = pakoInflate.inflate(strm, this.flush)
    }
  }

  /** UNZIP: gzip if the stream starts with gzip's magic bytes, which may arrive one call apart. */
  private detectGzip(): void {
    const strm = this.strm
    if (strm.avail_in === 0) return
    let next = strm.next_in
    if (this.gzipIdBytesRead === 0) {
      if (strm.input![next] !== GZIP_HEADER_ID1) {
        this.mode = INFLATE
        return
      }
      this.gzipIdBytesRead = 1
      if (++next === strm.next_in + strm.avail_in) return
    }
    if (strm.input![next] === GZIP_HEADER_ID2) {
      this.gzipIdBytesRead = 2
      this.mode = GUNZIP
    } else {
      this.mode = INFLATE
    }
  }

  /** GetErrorInfo: undefined when the stream is in a normal state. */
  errorInfo(): CompressionError | undefined {
    switch (this.err) {
      case Z_OK:
      case Z_BUF_ERROR:
        if (this.strm.avail_out !== 0 && this.flush === Z_FINISH) return this.error('unexpected end of file')
        return undefined
      case Z_STREAM_END:
        return undefined
      case Z_NEED_DICT:
        return this.error(this.dictionary ? 'Bad dictionary' : 'Missing dictionary')
      default:
        return this.error('Zlib error')
    }
  }

  resetStream(): CompressionError | undefined {
    if (this.initZlib() && this.err !== Z_OK) return this.error('Failed to init stream before reset')
    this.err = Z_OK
    if (this.mode === DEFLATE || this.mode === DEFLATERAW || this.mode === GZIP) this.err = pakoDeflate.deflateReset(this.strm)
    else if (this.mode === INFLATE || this.mode === INFLATERAW || this.mode === GUNZIP) this.err = pakoInflate.inflateReset(this.strm)
    if (this.err !== Z_OK) return this.error('Failed to reset stream')
    return this.setDictionary()
  }

  /**
   * pako has no deflateParams(). Before any input the stream is simply recreated with the new
   * settings; afterwards the change is ignored, which affects only the compression ratio.
   */
  setParams(level: number, strategy: number): CompressionError | undefined {
    if (this.mode !== DEFLATE && this.mode !== DEFLATERAW) return undefined
    this.level = level
    this.strategy = strategy
    if (this.initDone && this.strm.total_in === 0) {
      pakoDeflate.deflateEnd(this.strm)
      this.strm = new ZStream()
      this.initDone = false
    }
    return undefined
  }

  close(): void {
    if (!this.initDone) return
    if (this.mode === DEFLATE || this.mode === GZIP || this.mode === DEFLATERAW) pakoDeflate.deflateEnd(this.strm)
    else if (this.mode) pakoInflate.inflateEnd(this.strm)
    this.mode = 0
  }

  private error(message: string): CompressionError {
    return { message: this.strm.msg || message, code: ERROR_CODES[this.err] ?? 'Z_UNKNOWN', err: this.err }
  }

  /** Initializes zlib on first use; returns true on that first call. */
  private initZlib(): boolean {
    if (this.initDone) return false
    this.initDone = true
    switch (this.mode) {
      case DEFLATE:
      case GZIP:
      case DEFLATERAW:
        this.err = pakoDeflate.deflateInit2(this.strm, this.level, Z_DEFLATED, this.windowBits, this.memLevel, this.strategy)
        break
      case INFLATE:
      case GUNZIP:
      case INFLATERAW:
      case UNZIP:
        this.err = pakoInflate.inflateInit2(this.strm, this.windowBits)
        break
      default:
        throw new Error(`Invalid zlib mode ${this.mode}`)
    }
    if (this.err !== Z_OK) {
      this.mode = 0
      return true
    }
    this.setDictionary()
    return true
  }

  private setDictionary(): CompressionError | undefined {
    if (!this.dictionary) return undefined
    this.err = Z_OK
    if (this.mode === DEFLATE || this.mode === DEFLATERAW) this.err = pakoDeflate.deflateSetDictionary(this.strm, this.dictionary)
    // Other inflate modes set it when inflate() asks for it.
    else if (this.mode === INFLATERAW) this.err = pakoInflate.inflateSetDictionary(this.strm, this.dictionary)
    return this.err === Z_OK ? undefined : this.error('Failed to set dictionary')
  }
}

export function zlibBindings() {
  return {
    zlib: (realm: Realm) => {
      const { loop } = realm

      /** CompressionStream<ZlibContext>, as JavaScript sees it. */
      class Zlib {
        onerror?: (message: string, errno: number, code: string) => void
        private readonly ctx: ZlibContext
        private writeResult?: Uint32Array
        private writeCallback?: () => void
        private writeInProgress = false
        private pendingClose = false
        private closed = false

        constructor(mode: number) {
          this.ctx = new ZlibContext(mode)
        }

        init(
          windowBits: number,
          level: number,
          memLevel: number,
          strategy: number,
          writeResult: Uint32Array,
          writeCallback: () => void,
          dictionary?: ArrayBufferView,
          rejectGarbageAfterEnd = false,
        ) {
          this.writeResult = writeResult
          this.writeCallback = writeCallback
          this.ctx.init(level, windowBits, memLevel, strategy, rejectGarbageAfterEnd, dictionary && bytesOf(dictionary).slice())
        }

        params(level: number, strategy: number) {
          const error = this.ctx.setParams(level, strategy)
          if (error) this.emitError(error)
        }

        reset() {
          const error = this.ctx.resetStream()
          if (error) this.emitError(error)
        }

        close() {
          if (this.writeInProgress) {
            this.pendingClose = true
            return
          }
          this.pendingClose = false
          this.closed = true
          this.ctx.close()
        }

        writeSync(flush: number, input: Uint8Array, inOff: number, inLen: number, out: Uint8Array, outOff: number, outLen: number) {
          this.begin(flush, input, inOff, inLen, out, outOff, outLen)
          this.ctx.work()
          if (this.checkError()) {
            this.updateWriteResult()
            this.writeInProgress = false
          }
        }

        write(flush: number, input: Uint8Array, inOff: number, inLen: number, out: Uint8Array, outOff: number, outLen: number) {
          this.begin(flush, input, inOff, inLen, out, outOff, outLen)
          loop.requestStarted()
          loop.defer(() => {
            this.ctx.work()
            this.writeInProgress = false
            loop.requestFinished()
            loop.callback(() => {
              if (!this.checkError()) return
              this.updateWriteResult()
              this.writeCallback?.call(this)
              if (this.pendingClose) this.close()
            })
          })
        }

        getAsyncId() {
          return -1
        }

        private begin(flush: number, input: Uint8Array, inOff: number, inLen: number, out: Uint8Array, outOff: number, outLen: number) {
          if (this.closed) throw new Error('zlib binding closed')
          if (this.writeInProgress) throw new Error('write already in progress')
          this.writeInProgress = true
          this.ctx.setBuffers(input ?? new Uint8Array(0), inOff, inLen, out, outOff, outLen)
          this.ctx.flush = flush
        }

        private checkError(): boolean {
          const error = this.ctx.errorInfo()
          if (!error) return true
          this.emitError(error)
          return false
        }

        private emitError(error: CompressionError) {
          this.onerror?.call(this, error.message, error.err, error.code)
          this.writeInProgress = false
          if (this.pendingClose) this.close()
        }

        private updateWriteResult() {
          this.writeResult![0] = this.ctx.availOut
          this.writeResult![1] = this.ctx.availIn
        }
      }

      const unsupported = (name: string) =>
        class {
          constructor() {
            throw new Error(`${name} is not supported yet (webcore)`)
          }
        }

      return {
        Zlib,
        BrotliEncoder: unsupported('Brotli compression'),
        BrotliDecoder: unsupported('Brotli decompression'),
        ZstdCompress: unsupported('Zstandard compression'),
        ZstdDecompress: unsupported('Zstandard decompression'),
        crc32: (data: string | ArrayBufferView, value = 0) => {
          const bytes = typeof data === 'string' ? encode(data, 'utf8') : bytesOf(data)
          return pakoCrc32(value, bytes, bytes.length, 0) >>> 0
        },
      }
    },
  }
}
