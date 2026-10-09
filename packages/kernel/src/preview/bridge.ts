// The host side of previews (ADR-0014). A preview runs in an iframe on its own origin,
// `p<port>.<host>`, where a Service Worker forwards every request over a MessagePort to this
// bridge, which answers it from the server listening on that port inside the kernel. WebSockets,
// which Service Workers can't intercept, are relayed the same way by the client script injected
// into every HTML page.
import type { Kernel } from '../kernel/kernel.ts'
import { Errno, KernelError } from '../abi/errno.ts'
import { kernelFetch, readBody, type KernelResponse } from '../host/http.ts'
import { latin1 } from '../lib/http-parser.ts'
import { BOOT_PAGE_PATH, CLIENT_SCRIPT_PATH, previewPortOf, type FetchMessage, type PreviewReply, type PreviewRequest } from './protocol.ts'
import { KernelWebSocket } from './websocket.ts'

/** The parts of a MessagePort the bridge uses (browser and Node ports both fit). */
export interface MessagePortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  start(): void
}

export interface PreviewBridgeOptions {
  /** The origin that previews `port`; its hostname must start with the label `p<port>`. */
  origin?: (port: number) => string
}

// The bridge sets these itself, or they describe the browser's connection rather than the request.
const SKIP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'upgrade', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'content-length',
  'proxy-connection', 'proxy-authorization', 'cookie',
  // Servers then answer uncompressed; a body the bridge must decompress costs a copy.
  'accept-encoding',
])
const SKIP_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'set-cookie'])
const DECOMPRESSIBLE = new Set(['gzip', 'deflate', 'deflate-raw'])
const CLIENT_TAG = new TextEncoder().encode(`<script src="${CLIENT_SCRIPT_PATH}"></script>`)

/** A preview origin on localhost subdomains, which browsers resolve to the loopback address. */
export function localPreviewOrigin(port: number, base: { protocol: string; port: string } = location): string {
  return `${base.protocol}//p${port}.localhost${base.port ? `:${base.port}` : ''}`
}

/** Inserts the client script tag at the start of <head> (or of the document). */
export function injectClientScript(html: Uint8Array): Uint8Array {
  // Markup is ASCII, so searching a Latin-1 view finds byte offsets in any ASCII-compatible charset.
  const text = latin1(html, 0, Math.min(html.length, 64 * 1024))
  const head = /<head(?:\s[^>]*)?>/i.exec(text)
  const htmlTag = head ? undefined : /<html(?:\s[^>]*)?>/i.exec(text)
  const doctype = head || htmlTag ? undefined : /^\s*<!doctype[^>]*>/i.exec(text)
  const match = head ?? htmlTag ?? doctype
  const at = match ? match.index + match[0].length : 0
  const out = new Uint8Array(html.length + CLIENT_TAG.length)
  out.set(html.subarray(0, at))
  out.set(CLIENT_TAG, at)
  out.set(html.subarray(at), at + CLIENT_TAG.length)
  return out
}

function header(headers: [string, string][], name: string): string | undefined {
  return headers.find(([key]) => key.toLowerCase() === name)?.[1]
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`)
}

export class PreviewBridge {
  readonly origin: (port: number) => string
  private readonly kernel: Kernel
  /** Cookies per port. Service Worker responses can't set cookies, so the bridge keeps them. */
  private readonly cookies = new Map<number, Map<string, string>>()

  constructor(kernel: Kernel, options: PreviewBridgeOptions = {}) {
    this.kernel = kernel
    this.origin = options.origin ?? ((port) => localPreviewOrigin(port))
  }

  /** The URL to load in an iframe to preview `path` on `port`. */
  url(port: number, path = '/'): string {
    return `${this.origin(port)}${BOOT_PAGE_PATH}?path=${encodeURIComponent(path)}`
  }

  /** Accepts channels from preview frames that post `webcore:connect` to `target`. */
  listen(target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'webcore:connect' || !event.ports[0]) return
      let port: number | undefined
      try {
        port = previewPortOf(new URL(event.origin).hostname)
      } catch {
        return
      }
      // Only our own preview origins may talk to the kernel.
      if (port === undefined || this.origin(port) !== event.origin) return
      this.serve(event.ports[0], port)
    }
    target.addEventListener('message', onMessage as EventListener)
    return () => target.removeEventListener('message', onMessage as EventListener)
  }

  /**
   * Answers requests arriving on `channel`. A channel from a preview page can fetch only from the
   * port that page previews, as a browser keeps origins apart. WebSockets may connect to any port,
   * as in a browser; servers see the page's Origin.
   */
  serve(channel: MessagePortLike, port?: number): void {
    const requests = new Map<number, AbortController>()
    const sockets = new Map<number, KernelWebSocket>()
    channel.addEventListener('message', (event) => {
      const message = event.data as PreviewRequest
      switch (message?.type) {
        case 'fetch':
          if (port !== undefined && message.port !== port) {
            channel.postMessage({ type: 'error', id: message.id, message: `This preview can't fetch from port ${message.port}` } satisfies PreviewReply)
            break
          }
          void this.fetch(channel, message, requests)
          break
        case 'abort':
          requests.get(message.id)?.abort()
          break
        case 'ws-open':
          void this.openWebSocket(channel, message, sockets)
          break
        case 'ws-send':
          sockets.get(message.id)?.send(typeof message.data === 'string' ? message.data : new Uint8Array(message.data))
          break
        case 'ws-close':
          sockets.get(message.id)?.close(message.code, message.reason)
          break
      }
    })
    channel.start()
  }

  private async fetch(channel: MessagePortLike, message: FetchMessage, requests: Map<number, AbortController>): Promise<void> {
    const { id } = message
    const reply = (body: PreviewReply, transfer: Transferable[] = []) => channel.postMessage(body, transfer)
    const abort = new AbortController()
    requests.set(id, abort)
    try {
      const headers = message.headers.filter(([name]) => !SKIP_REQUEST_HEADERS.has(name.toLowerCase()))
      headers.push(['Host', message.host])
      const cookie = this.cookieHeader(message.port)
      if (cookie) headers.push(['Cookie', cookie])

      let response: KernelResponse
      try {
        response = await kernelFetch(this.kernel, message.port, {
          method: message.method,
          path: message.url,
          headers,
          body: message.body && new Uint8Array(message.body),
        })
      } catch (error) {
        const refused = error instanceof KernelError && error.errno === Errno.ECONNREFUSED
        response = this.errorResponse(message, refused ? 502 : 500, error)
      }
      this.storeCookies(message.port, response.headers)

      let responseHeaders = response.headers.filter(([name]) => !SKIP_RESPONSE_HEADERS.has(name.toLowerCase()))
      let body = response.body
      const encoding = header(responseHeaders, 'content-encoding')?.toLowerCase()
      if (encoding && DECOMPRESSIBLE.has(encoding)) {
        body = body.pipeThrough(new DecompressionStream(encoding as CompressionFormat) as unknown as TransformStream<Uint8Array, Uint8Array>)
        responseHeaders = responseHeaders.filter(([name]) => !/^content-(encoding|length)$/i.test(name))
      }
      if (message.navigate && /^text\/html/i.test(header(responseHeaders, 'content-type') ?? '')) {
        const html = injectClientScript(await readBody(body))
        body = new Blob([html as Uint8Array<ArrayBuffer>]).stream()
        responseHeaders = responseHeaders.filter(([name]) => name.toLowerCase() !== 'content-length')
      }

      reply({ type: 'head', id, status: response.status, statusText: response.statusText, headers: responseHeaders })
      const reader = body.getReader()
      abort.signal.addEventListener('abort', () => void reader.cancel().catch(() => {}))
      for (;;) {
        const { done, value } = await reader.read()
        if (done || abort.signal.aborted) break
        const data = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength ? value : value.slice()
        reply({ type: 'chunk', id, data }, [data.buffer as ArrayBuffer])
      }
      if (!abort.signal.aborted) reply({ type: 'end', id })
    } catch (error) {
      if (!abort.signal.aborted) reply({ type: 'error', id, message: error instanceof Error ? error.message : String(error) })
    } finally {
      requests.delete(id)
    }
  }

  private async openWebSocket(
    channel: MessagePortLike,
    message: Extract<PreviewRequest, { type: 'ws-open' }>,
    sockets: Map<number, KernelWebSocket>,
  ): Promise<void> {
    const { id } = message
    const reply = (body: PreviewReply, transfer: Transferable[] = []) => channel.postMessage(body, transfer)
    const headers: [string, string][] = [
      ['Host', message.host],
      ['Origin', message.origin],
    ]
    const cookie = this.cookieHeader(message.port)
    if (cookie) headers.push(['Cookie', cookie])
    let ws: KernelWebSocket
    try {
      ws = await KernelWebSocket.connect(this.kernel, message.port, { path: message.url, protocols: message.protocols, headers })
    } catch {
      reply({ type: 'ws-close', id, code: 1006, reason: '', wasClean: false })
      return
    }
    sockets.set(id, ws)
    reply({ type: 'ws-open', id, protocol: ws.protocol, extensions: ws.extensions })
    ws.start({
      onMessage: (data) => {
        if (typeof data === 'string') reply({ type: 'ws-message', id, data })
        else reply({ type: 'ws-message', id, data: data.buffer as ArrayBuffer }, [data.buffer as ArrayBuffer])
      },
      onClose: (code, reason, wasClean) => {
        sockets.delete(id)
        reply({ type: 'ws-close', id, code, reason, wasClean })
      },
    })
  }

  /** A page explaining why the request failed; navigations retry until a server appears. */
  private errorResponse(message: FetchMessage, status: number, error: unknown): KernelResponse {
    const detail =
      status === 502
        ? `Nothing is listening on port ${message.port} inside webcore yet. This page reloads when a server starts.`
        : `The request to port ${message.port} failed: ${error instanceof Error ? error.message : String(error)}`
    const html = message.navigate
      ? `<!doctype html><meta charset="utf-8"><title>Port ${message.port}</title>${status === 502 ? '<meta http-equiv="refresh" content="2">' : ''}` +
        `<body style="font: 14px system-ui, sans-serif; color: #555; padding: 2rem"><p>${escapeHtml(detail)}</p></body>`
      : detail
    return {
      status,
      statusText: status === 502 ? 'Bad Gateway' : 'Internal Server Error',
      headers: [['Content-Type', message.navigate ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8']],
      body: new Blob([html]).stream(),
    }
  }

  private cookieHeader(port: number): string | undefined {
    const jar = this.cookies.get(port)
    if (!jar?.size) return undefined
    return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  private storeCookies(port: number, headers: [string, string][]): void {
    for (const [name, value] of headers) {
      if (name.toLowerCase() !== 'set-cookie') continue
      const [pair, ...attributes] = value.split(';')
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const key = pair.slice(0, eq).trim()
      const expired = attributes.some((attribute) => {
        const [attr, attrValue = ''] = attribute.split('=')
        const lower = attr.trim().toLowerCase()
        return (lower === 'max-age' && Number(attrValue) <= 0) || (lower === 'expires' && Date.parse(attrValue) <= Date.now())
      })
      let jar = this.cookies.get(port)
      if (!jar) this.cookies.set(port, (jar = new Map()))
      if (expired) jar.delete(key)
      else jar.set(key, pair.slice(eq + 1).trim())
    }
  }
}
