// An incremental HTTP/1.1 parser with llhttp's semantics (the parser inside Node), without the
// lenient modes. Node's `http_parser` binding wraps it, and the preview bridge uses it on the host
// side to read responses. It has no dependencies, so it runs in any environment.
//
// Feed bytes with execute(); callbacks fire as messages are recognized. Differences from llhttp:
// the head (start line and headers) is delivered in one piece, and bare LF line endings are
// accepted.

export const REQUEST = 1
export const RESPONSE = 2

/** llhttp's HTTP_METHOD_MAP: the methods an HTTP request may use. */
export const METHODS = [
  'DELETE', 'GET', 'HEAD', 'POST', 'PUT', 'CONNECT', 'OPTIONS', 'TRACE', 'COPY', 'LOCK', 'MKCOL',
  'MOVE', 'PROPFIND', 'PROPPATCH', 'SEARCH', 'UNLOCK', 'BIND', 'REBIND', 'UNBIND', 'ACL', 'REPORT',
  'MKACTIVITY', 'CHECKOUT', 'MERGE', 'M-SEARCH', 'NOTIFY', 'SUBSCRIBE', 'UNSUBSCRIBE', 'PATCH',
  'PURGE', 'MKCALENDAR', 'LINK', 'UNLINK', 'SOURCE', 'QUERY',
]

/** llhttp's HTTP_ALL_METHOD_MAP (adds RTSP and PRI). A request's method is an index into this. */
export const ALL_METHODS = [
  'DELETE', 'GET', 'HEAD', 'POST', 'PUT', 'CONNECT', 'OPTIONS', 'TRACE', 'COPY', 'LOCK', 'MKCOL',
  'MOVE', 'PROPFIND', 'PROPPATCH', 'SEARCH', 'UNLOCK', 'BIND', 'REBIND', 'UNBIND', 'ACL', 'REPORT',
  'MKACTIVITY', 'CHECKOUT', 'MERGE', 'M-SEARCH', 'NOTIFY', 'SUBSCRIBE', 'UNSUBSCRIBE', 'PATCH',
  'PURGE', 'MKCALENDAR', 'LINK', 'UNLINK', 'SOURCE', 'PRI', 'DESCRIBE', 'ANNOUNCE', 'SETUP', 'PLAY',
  'PAUSE', 'TEARDOWN', 'GET_PARAMETER', 'SET_PARAMETER', 'REDIRECT', 'RECORD', 'FLUSH', 'QUERY',
]

const REQUEST_METHODS = new Map([...METHODS, 'PRI'].map((name) => [name, ALL_METHODS.indexOf(name)]))
const CONNECT = ALL_METHODS.indexOf('CONNECT')

export interface MessageHead {
  versionMajor: number
  versionMinor: number
  /** Flat [name, value, name, value, …], names as sent, values trimmed. */
  headers: string[]
  /** Requests: an index into ALL_METHODS. */
  method: number
  /** Requests: the request target. */
  url: string
  /** Responses. */
  statusCode: number
  statusMessage: string
  upgrade: boolean
  shouldKeepAlive: boolean
}

/** Return values for onHeadersComplete, as in llhttp. */
export const SKIP_BODY = 1
export const SKIP_BODY_AND_UPGRADE = 2

export interface HttpParserHandler {
  onMessageBegin?(): void
  /** May return SKIP_BODY (a response to HEAD) or SKIP_BODY_AND_UPGRADE. */
  onHeadersComplete(head: MessageHead): number | void
  onBody?(chunk: Uint8Array): void
  /** Trailing headers of a chunked message, just before onMessageComplete. */
  onTrailers?(headers: string[]): void
  onMessageComplete?(): void
}

/** A parse error: `code` is llhttp's error name, e.g. HPE_INVALID_METHOD. */
export interface HttpParseError {
  code: string
  reason: string
  /** Bytes of the failing execute() call consumed before the error. */
  bytesParsed: number
}

const State = {
  Start: 0,
  Head: 1,
  BodyLength: 2,
  ChunkSize: 3,
  ChunkData: 4,
  ChunkDataEnd: 5,
  Trailers: 6,
  BodyEof: 7,
  Closed: 8,
  Failed: 9,
} as const
type State = (typeof State)[keyof typeof State]

// llhttp's F_* flags.
const Flag = {
  ConnectionKeepAlive: 1 << 0,
  ConnectionClose: 1 << 1,
  ConnectionUpgrade: 1 << 2,
  Chunked: 1 << 3,
  Upgrade: 1 << 4,
  ContentLength: 1 << 5,
  SkipBody: 1 << 6,
  TransferEncoding: 1 << 8,
} as const

const CR = 13
const LF = 10
const MAX_CHUNK_LINE = 16 * 1024
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
// Field values may contain HTAB, SP, visible ASCII and obs-text (0x80-0xff), but no other controls.
const INVALID_VALUE = /[\0-\x08\x0a-\x1f\x7f]/
const INVALID_URL = /[\0-\x20\x7f]/

export class HttpParser {
  type: number
  maxHeaderSize: number
  private readonly handler: HttpParserHandler
  private state: State = State.Start
  private flags = 0
  private contentLength = 0
  private remaining = 0
  private method = -1
  private statusCode = 0
  private versionMajor = 0
  private versionMinor = 0
  private upgrade = false
  private paused = false
  private failure?: { code: string; reason: string }
  // The line-oriented part being collected: the head, a chunk-size line or the trailers.
  private buf = new Uint8Array(1024)
  private len = 0
  private lineStart = 0
  /** Whether the current message's head has been delivered. */
  headersCompleted = false

  constructor(type: number, handler: HttpParserHandler, maxHeaderSize = 16 * 1024) {
    this.type = type
    this.handler = handler
    this.maxHeaderSize = maxHeaderSize
  }

  /** Starts over, as a parser of `type`. */
  reset(type = this.type): void {
    this.type = type
    this.state = State.Start
    this.flags = 0
    this.upgrade = false
    this.paused = false
    this.failure = undefined
    this.len = this.lineStart = 0
    this.headersCompleted = false
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
  }

  /**
   * Parses `data`. Returns the number of bytes consumed, or an error. After an upgrade (or CONNECT)
   * the count stops at the end of the message: the rest belongs to the new protocol.
   */
  execute(data: Uint8Array): number | HttpParseError {
    if (this.failure) return { ...this.failure, bytesParsed: 0 }
    if (this.paused) return { code: 'HPE_PAUSED', reason: 'Paused', bytesParsed: 0 }
    let i = 0
    try {
      while (i < data.length) {
        switch (this.state) {
          case State.Start:
          case State.Closed: {
            const byte = data[i]
            if (byte === CR || byte === LF) {
              i++
              break
            }
            if (this.state === State.Closed) return this.fail('HPE_CLOSED_CONNECTION', 'Data after `Connection: close`', i)
            this.state = State.Head
            this.headersCompleted = false
            this.handler.onMessageBegin?.()
            break
          }

          case State.Head:
          case State.Trailers: {
            const [next, done] = this.collectBlock(data, i)
            i = next
            if (this.len > this.maxHeaderSize) return this.fail('HPE_HEADER_OVERFLOW', 'Header overflow', i)
            if (!done) break
            const error = this.state === State.Head ? this.headDone() : this.trailersDone()
            if (error) return this.fail(error[0], error[1], i)
            if (this.upgrade && (this.state as State) === State.Start) return i
            break
          }

          case State.BodyLength:
          case State.ChunkData: {
            const n = Math.min(this.remaining, data.length - i)
            this.remaining -= n
            const chunk = data.subarray(i, i + n)
            i += n
            if (n) this.handler.onBody?.(chunk)
            if (this.remaining > 0) break
            if (this.state === State.ChunkData) {
              this.state = State.ChunkDataEnd
              this.len = this.lineStart = 0
            } else {
              this.messageComplete()
              if (this.upgrade) return i
            }
            break
          }

          case State.ChunkSize:
          case State.ChunkDataEnd: {
            const lf = data.indexOf(LF, i)
            const end = lf === -1 ? data.length : lf + 1
            this.append(data, i, end)
            i = end
            if (this.len > MAX_CHUNK_LINE) return this.fail('HPE_CHUNK_EXTENSIONS_OVERFLOW', 'Chunk extensions overflow', i)
            if (lf === -1) break
            const line = latin1(this.buf, 0, this.lineEnd())
            this.len = this.lineStart = 0
            if (this.state === State.ChunkDataEnd) {
              if (line !== '') return this.fail('HPE_STRICT', 'Expected LF after chunk data', i)
              this.state = State.ChunkSize
              break
            }
            const match = /^([0-9a-fA-F]+)[ \t]*(;.*)?$/.exec(line)
            if (!match) return this.fail('HPE_INVALID_CHUNK_SIZE', 'Invalid character in chunk size', i)
            const size = Number.parseInt(match[1], 16)
            if (!Number.isSafeInteger(size)) return this.fail('HPE_INVALID_CHUNK_SIZE', 'Chunk size overflow', i)
            if (size === 0) this.state = State.Trailers
            else {
              this.state = State.ChunkData
              this.remaining = size
            }
            break
          }

          case State.BodyEof: {
            this.handler.onBody?.(data.subarray(i))
            i = data.length
            break
          }

          case State.Failed:
            return { ...this.failure!, bytesParsed: i }
        }
      }
    } catch (error) {
      // A callback threw: the parser is unusable, and the exception is the caller's to handle.
      this.failure = { code: 'HPE_USER', reason: 'JS Exception' }
      this.state = State.Failed
      throw error
    }
    return data.length
  }

  /** Signals EOF. Completes a body that runs to EOF; anything else unfinished is an error. */
  finish(): HttpParseError | undefined {
    if (this.failure) return { ...this.failure, bytesParsed: 0 }
    switch (this.state) {
      case State.Start:
      case State.Closed:
        return undefined
      case State.BodyEof:
        this.messageComplete()
        return undefined
      default:
        return this.fail('HPE_INVALID_EOF_STATE', 'Invalid EOF state', 0)
    }
  }

  private fail(code: string, reason: string, bytesParsed: number): HttpParseError {
    this.failure = { code, reason }
    this.state = State.Failed
    return { code, reason, bytesParsed }
  }

  private append(data: Uint8Array, start: number, end: number): void {
    const needed = this.len + (end - start)
    if (needed > this.buf.length) {
      const grown = new Uint8Array(Math.max(needed, this.buf.length * 2))
      grown.set(this.buf.subarray(0, this.len))
      this.buf = grown
    }
    this.buf.set(data.subarray(start, end), this.len)
    this.len = needed
  }

  /** End of the line that was just appended, without its CR LF. */
  private lineEnd(): number {
    let end = this.len - 1
    if (end > this.lineStart && this.buf[end - 1] === CR) end--
    return end
  }

  /** Collects lines until an empty one. Returns [next index, whether the block is complete]. */
  private collectBlock(data: Uint8Array, i: number): [number, boolean] {
    while (i < data.length) {
      const lf = data.indexOf(LF, i)
      const end = lf === -1 ? data.length : lf + 1
      this.append(data, i, end)
      i = end
      if (lf === -1 || this.len > this.maxHeaderSize) return [i, false]
      if (this.lineEnd() === this.lineStart) return [i, true]
      this.lineStart = this.len
    }
    return [i, false]
  }

  private takeLines(): string[] {
    const text = latin1(this.buf, 0, this.len)
    this.len = this.lineStart = 0
    const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    // The block ends with an empty line, which leaves two empty strings after the split.
    lines.length -= 2
    return lines
  }

  private parseHeaders(lines: string[], from: number, headers: string[]): [string, string] | undefined {
    for (let n = from; n < lines.length; n++) {
      const line = lines[n]
      const colon = line.indexOf(':')
      const name = colon === -1 ? line : line.slice(0, colon)
      if (colon <= 0 || !TOKEN.test(name)) return ['HPE_INVALID_HEADER_TOKEN', 'Invalid header token']
      const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, '')
      if (INVALID_VALUE.test(value)) return ['HPE_INVALID_HEADER_TOKEN', 'Invalid header value char']
      headers.push(name, value)
    }
    return undefined
  }

  private headDone(): [string, string] | undefined {
    const lines = this.takeLines()
    const start = lines[0] ?? ''
    let url = ''
    let statusMessage = ''
    this.flags = 0
    this.contentLength = 0
    this.upgrade = false
    this.method = -1
    this.statusCode = 0

    if (this.type === REQUEST) {
      const space = start.indexOf(' ')
      const method = space === -1 ? undefined : REQUEST_METHODS.get(start.slice(0, space))
      if (method === undefined) return ['HPE_INVALID_METHOD', 'Invalid method encountered']
      const match = /^([^ ]+) HTTP\/(\d)\.(\d)$/.exec(start.slice(space + 1))
      if (!match) return ['HPE_INVALID_CONSTANT', 'Expected HTTP/']
      if (INVALID_URL.test(match[1])) return ['HPE_INVALID_URL', 'Invalid characters in url']
      this.method = method
      url = match[1]
      this.versionMajor = Number(match[2])
      this.versionMinor = Number(match[3])
    } else {
      const match = /^HTTP\/(\d)\.(\d) (\d{3})(?: (.*))?$/.exec(start)
      if (!match) {
        return start.startsWith('HTTP/') ? ['HPE_INVALID_STATUS', 'Invalid status code'] : ['HPE_INVALID_CONSTANT', 'Expected HTTP/']
      }
      this.versionMajor = Number(match[1])
      this.versionMinor = Number(match[2])
      this.statusCode = Number(match[3])
      statusMessage = match[4] ?? ''
    }
    if (this.versionMajor > 1 || (this.versionMajor === 1 && this.versionMinor > 1)) {
      return ['HPE_INVALID_VERSION', 'Invalid HTTP version']
    }

    const headers: string[] = []
    const error = this.parseHeaders(lines, 1, headers)
    if (error) return error
    for (let n = 0; n < headers.length; n += 2) {
      const name = headers[n].toLowerCase()
      const value = headers[n + 1]
      if (name === 'content-length') {
        if (this.flags & Flag.ContentLength) return ['HPE_UNEXPECTED_CONTENT_LENGTH', 'Duplicate Content-Length']
        if (!/^\d+$/.test(value)) return ['HPE_INVALID_CONTENT_LENGTH', 'Invalid character in Content-Length']
        this.flags |= Flag.ContentLength
        this.contentLength = Number(value)
        if (!Number.isSafeInteger(this.contentLength)) return ['HPE_INVALID_CONTENT_LENGTH', 'Content-Length overflow']
      } else if (name === 'transfer-encoding') {
        this.flags |= Flag.TransferEncoding
        const codings = value.toLowerCase().split(',').map((coding) => coding.trim())
        if (codings[codings.length - 1] === 'chunked') this.flags |= Flag.Chunked
        else this.flags &= ~Flag.Chunked
      } else if (name === 'connection') {
        for (const token of value.toLowerCase().split(',')) {
          const option = token.trim()
          if (option === 'close') this.flags |= Flag.ConnectionClose
          else if (option === 'keep-alive') this.flags |= Flag.ConnectionKeepAlive
          else if (option === 'upgrade') this.flags |= Flag.ConnectionUpgrade
        }
      } else if (name === 'upgrade') {
        this.flags |= Flag.Upgrade
      }
    }
    if (this.flags & Flag.TransferEncoding && this.flags & Flag.ContentLength) {
      return ['HPE_UNEXPECTED_CONTENT_LENGTH', "Content-Length can't be present with Transfer-Encoding"]
    }

    if (this.flags & Flag.Upgrade && this.flags & Flag.ConnectionUpgrade) {
      // For responses, the upgrade headers only switch protocols on 101.
      this.upgrade = this.type === REQUEST || this.statusCode === 101
    } else {
      this.upgrade = this.method === CONNECT
    }

    const head: MessageHead = {
      versionMajor: this.versionMajor,
      versionMinor: this.versionMinor,
      headers,
      method: this.method,
      url,
      statusCode: this.statusCode,
      statusMessage,
      upgrade: this.upgrade,
      shouldKeepAlive: this.shouldKeepAlive(),
    }
    this.headersCompleted = true
    const skip = this.handler.onHeadersComplete(head)
    if (skip === SKIP_BODY) this.flags |= Flag.SkipBody
    else if (skip === SKIP_BODY_AND_UPGRADE) {
      this.flags |= Flag.SkipBody
      this.upgrade = true
    }

    const hasBody = (this.flags & Flag.Chunked) !== 0 || this.contentLength > 0
    if (
      (this.upgrade && (this.method === CONNECT || this.flags & Flag.SkipBody || !hasBody)) ||
      (this.type === RESPONSE && this.statusCode === 101)
    ) {
      this.messageComplete()
    } else if (this.flags & Flag.SkipBody) {
      this.messageComplete()
    } else if (this.flags & Flag.Chunked) {
      this.state = State.ChunkSize
    } else if (this.flags & Flag.TransferEncoding) {
      if (this.type === REQUEST) return ['HPE_INVALID_TRANSFER_ENCODING', 'Request has invalid `Transfer-Encoding`']
      this.state = State.BodyEof
    } else if (!(this.flags & Flag.ContentLength)) {
      if (this.needsEof()) this.state = State.BodyEof
      else this.messageComplete()
    } else if (this.contentLength === 0) {
      this.messageComplete()
    } else {
      this.state = State.BodyLength
      this.remaining = this.contentLength
    }
    return undefined
  }

  private trailersDone(): [string, string] | undefined {
    const lines = this.takeLines()
    const trailers: string[] = []
    const error = this.parseHeaders(lines, 0, trailers)
    if (error) return error
    if (trailers.length) this.handler.onTrailers?.(trailers)
    this.messageComplete()
    return undefined
  }

  private messageComplete(): void {
    this.state = this.upgrade || this.shouldKeepAlive() ? State.Start : State.Closed
    this.handler.onMessageComplete?.()
  }

  private needsEof(): boolean {
    if (this.type === REQUEST) return false
    const status = this.statusCode
    if ((status >= 100 && status < 200) || status === 204 || status === 304 || this.flags & Flag.SkipBody) return false
    if (this.flags & Flag.TransferEncoding && !(this.flags & Flag.Chunked)) return true
    return !(this.flags & (Flag.Chunked | Flag.ContentLength))
  }

  private shouldKeepAlive(): boolean {
    if (this.versionMajor > 0 && this.versionMinor > 0) {
      if (this.flags & Flag.ConnectionClose) return false
    } else if (!(this.flags & Flag.ConnectionKeepAlive)) {
      return false
    }
    return !this.needsEof()
  }
}

/** Bytes as Latin-1 (one char per byte), as Node decodes header bytes. */
export function latin1(bytes: Uint8Array, start: number, end: number): string {
  let text = ''
  for (let i = start; i < end; i += 4096) {
    text += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + 4096)) as unknown as number[])
  }
  return text
}
