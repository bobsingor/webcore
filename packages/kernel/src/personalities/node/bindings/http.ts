// http_parser (src/node_http_parser.cc) over the TypeScript parser in lib/http-parser.ts.
//
// Node's server "consumes" StreamBase sockets: the C++ parser reads from the socket directly.
// Here consume() is a no-op, so bytes reach the parser through the socket's 'data' events, the
// path Node uses for any socket that isn't backed by a native stream.
import { host } from '../host.ts'
import { bytesOf } from '../codec.ts'
import type { Realm } from '../realm.ts'
import { ALL_METHODS, HttpParser, METHODS, REQUEST, RESPONSE, type HttpParseError, type MessageHead } from '../../../lib/http-parser.ts'

const kOnMessageBegin = 0
const kOnHeaders = 1
const kOnHeadersComplete = 2
const kOnBody = 3
const kOnMessageComplete = 4
const kOnExecute = 5
const kOnTimeout = 6

const LENIENT_FLAGS = {
  kLenientNone: 0,
  kLenientHeaders: 1 << 0,
  kLenientChunkedLength: 1 << 1,
  kLenientKeepAlive: 1 << 2,
  kLenientTransferEncoding: 1 << 3,
  kLenientVersion: 1 << 4,
  kLenientDataAfterClose: 1 << 5,
  kLenientOptionalLFAfterCR: 1 << 6,
  kLenientOptionalCRLFAfterChunk: 1 << 7,
  kLenientOptionalCRBeforeLF: 1 << 8,
  kLenientSpacesAfterChunkSize: 1 << 9,
  kLenientHeaderValueRelaxed: 1 << 10,
  kLenientAll: 0x3ff,
}

type Callback = (...args: unknown[]) => unknown

interface ParserState {
  core: HttpParser
  current?: Uint8Array
  connections?: Connections
  /** When the current message started (ms), or 0 between messages. */
  lastMessageStart: number
}

interface Connections {
  all: Set<object>
  active: Set<object>
}

export function httpBindings() {
  return {
    http_parser: (realm: Realm) => {
      const states = new WeakMap<object, ParserState>()
      const lists = new WeakMap<object, Connections>()
      const defaultMaxHeaderSize = Number(realm.commandLine.options['--max-http-header-size']) || 16 * 1024

      const stateOf = (parser: object): ParserState => {
        const state = states.get(parser)
        if (!state) throw new TypeError('Illegal invocation')
        return state
      }

      const callback = (parser: object, index: number): Callback | undefined => {
        const fn = (parser as Record<number, unknown>)[index]
        return typeof fn === 'function' ? (fn as Callback) : undefined
      }

      const track = (parser: object, state: ParserState, active: boolean) => {
        state.connections?.all.add(parser)
        if (active) state.connections?.active.add(parser)
      }

      const untrack = (parser: object, state: ParserState) => {
        state.connections?.all.delete(parser)
        state.connections?.active.delete(parser)
      }

      const parseError = (error: HttpParseError) =>
        Object.assign(new Error('Parse Error'), { bytesParsed: error.bytesParsed, code: error.code, reason: error.reason })

      class HTTPParser {
        static REQUEST = REQUEST
        static RESPONSE = RESPONSE
        static kOnMessageBegin = kOnMessageBegin
        static kOnHeaders = kOnHeaders
        static kOnHeadersComplete = kOnHeadersComplete
        static kOnBody = kOnBody
        static kOnMessageComplete = kOnMessageComplete
        static kOnExecute = kOnExecute
        static kOnTimeout = kOnTimeout

        constructor() {
          const parser = this
          const state: ParserState = {
            lastMessageStart: 0,
            core: new HttpParser(REQUEST, {
              onMessageBegin() {
                untrack(parser, state)
                state.lastMessageStart = host.performance.now()
                track(parser, state, true)
                callback(parser, kOnMessageBegin)?.call(parser)
              },
              onHeadersComplete(head: MessageHead) {
                const fn = callback(parser, kOnHeadersComplete)
                if (!fn) return 0
                const request = state.core.type === REQUEST
                const result = fn.call(
                  parser,
                  head.versionMajor,
                  head.versionMinor,
                  head.headers,
                  request ? head.method : undefined,
                  request ? head.url : undefined,
                  request ? undefined : head.statusCode,
                  request ? undefined : head.statusMessage,
                  head.upgrade,
                  head.shouldKeepAlive,
                )
                return Math.trunc(Number(result)) || 0
              },
              onBody(chunk) {
                callback(parser, kOnBody)?.call(parser, realm.newBuffer(chunk.slice()))
              },
              onTrailers(headers) {
                callback(parser, kOnHeaders)?.call(parser, headers, '')
              },
              onMessageComplete() {
                untrack(parser, state)
                state.lastMessageStart = 0
                track(parser, state, false)
                callback(parser, kOnMessageComplete)?.call(parser)
              },
            }),
          }
          states.set(this, state)
        }

        initialize(type: number, _resource: object, maxHeaderSize?: number, _lenientFlags?: number, connections?: object | null) {
          const state = stateOf(this)
          untrack(this, state)
          state.core.reset(type)
          state.core.maxHeaderSize = maxHeaderSize || defaultMaxHeaderSize
          state.connections = connections ? lists.get(connections) : undefined
          if (state.connections) {
            // Counts from now, so a client that connects and sends nothing still times out.
            state.lastMessageStart = host.performance.now()
            track(this, state, true)
          }
        }

        execute(buffer: ArrayBufferView) {
          const state = stateOf(this)
          state.current = bytesOf(buffer)
          try {
            const result = state.core.execute(state.current)
            return typeof result === 'number' ? result : parseError(result)
          } finally {
            state.current = undefined
          }
        }

        finish() {
          const error = stateOf(this).core.finish()
          return error ? parseError(error) : undefined
        }

        getCurrentBuffer() {
          return realm.newBuffer(stateOf(this).current?.slice() ?? new Uint8Array(0))
        }

        pause() {
          stateOf(this).core.pause()
        }

        resume() {
          stateOf(this).core.resume()
        }

        consume() {}

        unconsume() {}

        remove() {
          untrack(this, stateOf(this))
        }

        free() {}

        close() {}

        getAsyncId() {
          return -1
        }

        getProviderType() {
          return 0
        }
      }
      Object.assign(HTTPParser, LENIENT_FLAGS)

      class ConnectionsList {
        constructor() {
          lists.set(this, { all: new Set(), active: new Set() })
        }

        all() {
          return [...lists.get(this)!.all]
        }

        idle() {
          return [...lists.get(this)!.all].filter((parser) => stateOf(parser).lastMessageStart === 0)
        }

        active() {
          return [...lists.get(this)!.active]
        }

        /** Active connections past their deadlines (milliseconds), which stop being active. */
        expired(headersTimeout: number, requestTimeout: number) {
          const now = host.performance.now()
          const headersDeadline = headersTimeout > 0 && now > headersTimeout ? now - headersTimeout : 0
          const requestDeadline = requestTimeout > 0 && now > requestTimeout ? now - requestTimeout : 0
          if (!headersDeadline && !requestDeadline) return []
          const { active } = lists.get(this)!
          const expired: object[] = []
          for (const parser of active) {
            const state = stateOf(parser)
            if (
              (!state.core.headersCompleted && headersDeadline > 0 && state.lastMessageStart < headersDeadline) ||
              (requestDeadline > 0 && state.lastMessageStart < requestDeadline)
            ) {
              expired.push(parser)
              active.delete(parser)
            }
          }
          return expired
        }
      }

      return { HTTPParser, ConnectionsList, methods: [...METHODS], allMethods: [...ALL_METHODS] }
    },
  }
}
