// The HTTP/1.1 parser (src/lib/http-parser.ts) on its own: framing, chunking, errors, upgrades.
import { describe, expect, it } from 'vitest'
import { ALL_METHODS, HttpParser, REQUEST, RESPONSE, SKIP_BODY, type MessageHead } from '../src/index.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

interface Message {
  head: MessageHead
  body: string
  trailers?: string[]
  complete: boolean
}

function collect(type: number, skip?: (head: MessageHead) => number) {
  const messages: Message[] = []
  const parser = new HttpParser(type, {
    onHeadersComplete(head) {
      messages.push({ head, body: '', complete: false })
      return skip?.(head) ?? 0
    },
    onBody(chunk) {
      messages[messages.length - 1].body += decoder.decode(chunk)
    },
    onTrailers(trailers) {
      messages[messages.length - 1].trailers = trailers
    },
    onMessageComplete() {
      messages[messages.length - 1].complete = true
    },
  })
  return { parser, messages }
}

/** Feeds `text` in pieces of `size` bytes, as a slow network would. */
function feed(parser: HttpParser, text: string, size = Infinity) {
  const bytes = encoder.encode(text)
  const results = []
  for (let i = 0; i < bytes.length; i += size) results.push(parser.execute(bytes.subarray(i, Math.min(bytes.length, i + size))))
  return results
}

describe('HTTP parser', () => {
  it('parses pipelined requests, whatever the chunk boundaries', () => {
    const text =
      'GET /a?x=1 HTTP/1.1\r\nHost: example\r\nX-Spaced:   padded value  \r\n\r\n' +
      'POST /b HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello' +
      'PUT /c HTTP/1.0\r\nTransfer-Encoding: chunked\r\n\r\n3;ext=1\r\nabc\r\n2\r\nde\r\n0\r\nX-Trailer: t\r\n\r\n'
    for (const size of [1, 7, Infinity]) {
      const { parser, messages } = collect(REQUEST)
      expect(feed(parser, text, size).every((result) => typeof result === 'number')).toBe(true)
      expect(messages.map((m) => [ALL_METHODS[m.head.method], m.head.url, m.body, m.complete])).toEqual([
        ['GET', '/a?x=1', '', true],
        ['POST', '/b', 'hello', true],
        ['PUT', '/c', 'abcde', true],
      ])
      expect(messages[0].head.headers).toEqual(['Host', 'example', 'X-Spaced', 'padded value'])
      expect(messages[0].head.shouldKeepAlive).toBe(true)
      expect(messages[2].head.shouldKeepAlive).toBe(false)
      expect(messages[2].trailers).toEqual(['X-Trailer', 't'])
    }
  })

  it('reads a response body to EOF when it has no length', () => {
    const { parser, messages } = collect(RESPONSE)
    feed(parser, 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\npart one, ')
    feed(parser, 'part two')
    expect(messages[0].complete).toBe(false)
    expect(parser.finish()).toBeUndefined()
    expect(messages[0]).toMatchObject({ body: 'part one, part two', complete: true })
    expect(messages[0].head).toMatchObject({ statusCode: 200, statusMessage: 'OK', shouldKeepAlive: false })
  })

  it('skips bodies of interim, 204 and HEAD responses', () => {
    const { parser, messages } = collect(RESPONSE, (head) => (head.statusCode === 200 ? SKIP_BODY : 0))
    feed(parser, 'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 204 No Content\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n')
    expect(messages.map((m) => [m.head.statusCode, m.complete])).toEqual([
      [100, true],
      [204, true],
      [200, true],
    ])
  })

  it('stops at the end of an upgrade request', () => {
    const { parser, messages } = collect(REQUEST)
    const head = 'GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
    expect(feed(parser, `${head}\x81\x05hello`)).toEqual([head.length])
    expect(messages[0].head.upgrade).toBe(true)
    expect(messages[0].complete).toBe(true)
  })

  it('reports errors with llhttp codes', () => {
    const error = (type: number, text: string, maxHeaderSize?: number) => {
      const { parser } = collect(type)
      if (maxHeaderSize) parser.maxHeaderSize = maxHeaderSize
      return feed(parser, text).find((result) => typeof result === 'object')
    }
    expect(error(REQUEST, 'BREW /pot HTTP/1.1\r\n\r\n')).toMatchObject({ code: 'HPE_INVALID_METHOD' })
    expect(error(REQUEST, 'GET / HTTP/1.1\r\nBad Header: x\r\n\r\n')).toMatchObject({ code: 'HPE_INVALID_HEADER_TOKEN' })
    expect(error(REQUEST, 'GET / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n')).toMatchObject({
      code: 'HPE_UNEXPECTED_CONTENT_LENGTH',
    })
    expect(error(REQUEST, `GET / HTTP/1.1\r\nX: ${'a'.repeat(100)}\r\n\r\n`, 64)).toMatchObject({ code: 'HPE_HEADER_OVERFLOW' })
    expect(error(REQUEST, 'GET / HTTP/1.1\r\nConnection: close\r\n\r\nGET / HTTP/1.1\r\n\r\n')).toMatchObject({
      code: 'HPE_CLOSED_CONNECTION',
    })
    expect(error(RESPONSE, 'HTTP/1.1 2000 Nope\r\n\r\n')).toMatchObject({ code: 'HPE_INVALID_STATUS' })
    expect(error(RESPONSE, 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n')).toMatchObject({
      code: 'HPE_INVALID_CHUNK_SIZE',
    })

    const { parser } = collect(RESPONSE)
    feed(parser, 'HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort')
    expect(parser.finish()).toMatchObject({ code: 'HPE_INVALID_EOF_STATE' })
  })
})
