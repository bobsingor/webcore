// HTTP from the host into the kernel: one request per virtual TCP connection (Connection: close),
// with the response parsed by lib/http-parser.ts. The preview bridge serves iframes with it, and
// tests use it to talk to servers running inside the kernel.
import type { Kernel } from '../kernel/kernel.ts'
import { HttpParser, RESPONSE, SKIP_BODY, type MessageHead } from '../lib/http-parser.ts'

export interface KernelRequest {
  method?: string
  /** Path and query, e.g. `/index.html?x=1`. */
  path?: string
  /** Request headers. Hop-by-hop headers are replaced; Host defaults to `localhost:<port>`. */
  headers?: Iterable<[string, string]> | Record<string, string>
  body?: Uint8Array | string
}

export interface KernelResponse {
  status: number
  statusText: string
  /** In order, names as sent; repeated headers (Set-Cookie) stay separate. */
  headers: [string, string][]
  /** Ends when the message does; cancel it to drop the connection. */
  body: ReadableStream<Uint8Array>
}

const encoder = new TextEncoder()
// Owned by this client: it sends exactly one message per connection, with a known length.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade', 'te', 'trailer', 'proxy-connection'])
const READ_CHUNK = 64 * 1024

function headerPairs(headers: KernelRequest['headers']): [string, string][] {
  if (!headers) return []
  if (Symbol.iterator in headers) return [...(headers as Iterable<[string, string]>)]
  return Object.entries(headers)
}

function pairs(flat: string[]): [string, string][] {
  const out: [string, string][] = []
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]])
  return out
}

/** Serializes a request head. Header names and values must already be valid. */
export function requestHead(port: number, request: KernelRequest, extra: [string, string][] = []): string {
  const method = (request.method ?? 'GET').toUpperCase()
  const lines = [`${method} ${request.path || '/'} HTTP/1.1`]
  let host = `localhost:${port}`
  for (const [name, value] of headerPairs(request.headers)) {
    const lower = name.toLowerCase()
    if (lower === 'host') host = value
    else if (!HOP_BY_HOP.has(lower)) lines.push(`${name}: ${value}`)
  }
  lines.splice(1, 0, `Host: ${host}`)
  for (const [name, value] of extra) lines.push(`${name}: ${value}`)
  return `${lines.join('\r\n')}\r\n\r\n`
}

/**
 * Sends one HTTP request to the server listening on `port` inside the kernel. Rejects with the
 * kernel's error (e.g. ECONNREFUSED) when nothing listens, or when the server closes the
 * connection before sending a complete response head.
 */
export async function kernelFetch(kernel: Kernel, port: number, request: KernelRequest = {}): Promise<KernelResponse> {
  const body = typeof request.body === 'string' ? encoder.encode(request.body) : request.body
  const method = (request.method ?? 'GET').toUpperCase()
  const needsLength = body !== undefined || ['POST', 'PUT', 'PATCH'].includes(method)
  const head = requestHead(port, request, [
    ['Connection', 'close'],
    ...(needsLength ? ([['Content-Length', String(body?.length ?? 0)]] as [string, string][]) : []),
  ])

  const socket = kernel.connect(port)
  let released = false
  const release = () => {
    if (released) return
    released = true
    socket.release()
  }

  let response: MessageHead | undefined
  let complete = false
  const pending: Uint8Array[] = []
  const parser = new HttpParser(RESPONSE, {
    onHeadersComplete(message) {
      // Interim responses (100 Continue, 103 Early Hints) aren't the answer.
      if (message.statusCode >= 100 && message.statusCode < 200 && message.statusCode !== 101) return 0
      response = message
      return method === 'HEAD' ? SKIP_BODY : 0
    },
    onBody(chunk) {
      pending.push(chunk.slice())
    },
    onMessageComplete() {
      if (response) complete = true
    },
  })

  /** Reads and parses one chunk; returns false at EOF. */
  const pump = async (): Promise<boolean> => {
    const chunk = await socket.read(READ_CHUNK)
    const result = chunk.length ? parser.execute(chunk) : parser.finish()
    if (typeof result === 'object') throw new Error(`Invalid HTTP response from port ${port}: ${result.reason} (${result.code})`)
    return chunk.length > 0
  }

  try {
    await socket.write(encoder.encode(head))
    if (body?.length) await socket.write(body)
    while (!response) {
      if (!(await pump())) throw new Error(`Port ${port} closed the connection without a response`)
    }
  } catch (error) {
    release()
    throw error
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!pending.length && !complete) {
          if (!(await pump()) && !complete) throw new Error(`Port ${port} closed the connection mid-response`)
        }
      } catch (error) {
        release()
        controller.error(error)
        return
      }
      for (const chunk of pending.splice(0)) controller.enqueue(chunk)
      if (complete) {
        release()
        controller.close()
      }
    },
    cancel() {
      release()
    },
  })

  return {
    status: response.statusCode,
    statusText: response.statusMessage,
    headers: pairs(response.headers),
    body: stream,
  }
}

/** Reads a whole body (for tests and small responses). */
export async function readBody(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for (const reader = body.getReader(); ; ) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
