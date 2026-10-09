// A WebSocket client (RFC 6455) over a kernel TCP connection. The preview bridge uses it so pages
// in a preview can open WebSockets to servers inside the kernel (Vite's HMR channel, for example):
// browsers can't intercept WebSocket connections the way a Service Worker intercepts fetches.
import type { Kernel } from '../kernel/kernel.ts'
import type { Socket } from '../kernel/net.ts'
import { requestHead } from '../host/http.ts'
import { HttpParser, RESPONSE, type MessageHead } from '../lib/http-parser.ts'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa
const MAX_MESSAGE = 64 * 1024 * 1024

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface WebSocketHandlers {
  onMessage(data: string | Uint8Array): void
  onClose(code: number, reason: string, wasClean: boolean): void
}

export interface KernelWebSocketOptions {
  /** Path and query of the WebSocket URL. */
  path: string
  protocols?: string[]
  /** Extra request headers (Origin, cookies). Host defaults to `localhost:<port>`. */
  headers?: [string, string][]
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

async function acceptKey(key: string): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.digest('SHA-1', encoder.encode(key + GUID))))
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

export class KernelWebSocket {
  readonly protocol: string
  readonly extensions: string
  private readonly socket: Socket
  private handlers?: WebSocketHandlers
  private buffered: Uint8Array
  private fragments: Uint8Array[] = []
  private fragmentType = 0
  private closeSent = false
  private closed = false
  private finished = false
  private closeTimer?: ReturnType<typeof setTimeout>
  private writing = Promise.resolve()

  private constructor(socket: Socket, head: MessageHead, leftover: Uint8Array) {
    this.socket = socket
    const header = (name: string) => {
      for (let i = 0; i < head.headers.length; i += 2) if (head.headers[i].toLowerCase() === name) return head.headers[i + 1]
      return ''
    }
    this.protocol = header('sec-websocket-protocol')
    this.extensions = header('sec-websocket-extensions')
    this.buffered = leftover
  }

  /** Opens a WebSocket to `port`. Rejects if the server refuses the upgrade. */
  static async connect(kernel: Kernel, port: number, options: KernelWebSocketOptions): Promise<KernelWebSocket> {
    const key = base64(crypto.getRandomValues(new Uint8Array(16)))
    const extra: [string, string][] = [
      ['Connection', 'Upgrade'],
      ['Upgrade', 'websocket'],
      ['Sec-WebSocket-Key', key],
      ['Sec-WebSocket-Version', '13'],
    ]
    if (options.protocols?.length) extra.push(['Sec-WebSocket-Protocol', options.protocols.join(', ')])
    const head = requestHead(port, { path: options.path, headers: options.headers }, extra)

    const socket = kernel.connect(port)
    try {
      await socket.write(encoder.encode(head))
      let response: MessageHead | undefined
      const parser = new HttpParser(RESPONSE, {
        onHeadersComplete(message) {
          response = message
          return 0
        },
      })
      for (;;) {
        const chunk = await socket.read(64 * 1024)
        if (!chunk.length) throw new Error('connection closed during the WebSocket handshake')
        const result = parser.execute(chunk)
        if (typeof result === 'object') throw new Error(`invalid handshake response: ${result.reason}`)
        if (!response) continue
        if (response.statusCode !== 101 || !response.upgrade) throw new Error(`server answered the upgrade with ${response.statusCode}`)
        const ws = new KernelWebSocket(socket, response, chunk.slice(result))
        const accept = response.headers.findIndex((name, i) => i % 2 === 0 && name.toLowerCase() === 'sec-websocket-accept')
        if (accept < 0 || response.headers[accept + 1] !== (await acceptKey(key))) throw new Error('invalid Sec-WebSocket-Accept')
        return ws
      }
    } catch (error) {
      socket.release()
      throw error
    }
  }

  /** Starts delivering messages. Call once, right after connect(). */
  start(handlers: WebSocketHandlers): void {
    this.handlers = handlers
    void this.readLoop()
  }

  send(data: string | Uint8Array): void {
    if (this.closeSent) return
    if (typeof data === 'string') this.sendFrame(OP_TEXT, encoder.encode(data))
    else this.sendFrame(OP_BINARY, data)
  }

  /** Starts the closing handshake; the server's reply ends the connection. */
  close(code = 1000, reason = ''): void {
    if (this.closeSent) return
    const reasonBytes = encoder.encode(reason).subarray(0, 123)
    const payload = new Uint8Array(2 + reasonBytes.length)
    new DataView(payload.buffer).setUint16(0, code)
    payload.set(reasonBytes, 2)
    this.sendFrame(OP_CLOSE, payload)
    this.closeSent = true
    // Don't wait forever for a server that never answers.
    this.closeTimer = setTimeout(() => this.finish(1006, '', false), 5000)
  }

  private sendFrame(opcode: number, payload: Uint8Array): void {
    const length = payload.length
    const headerLength = length < 126 ? 2 : length < 65536 ? 4 : 10
    const frame = new Uint8Array(headerLength + 4 + length)
    const view = new DataView(frame.buffer)
    frame[0] = 0x80 | opcode
    if (length < 126) frame[1] = 0x80 | length
    else if (length < 65536) {
      frame[1] = 0x80 | 126
      view.setUint16(2, length)
    } else {
      frame[1] = 0x80 | 127
      view.setBigUint64(2, BigInt(length))
    }
    // Clients mask every frame (RFC 6455 §5.3).
    const mask = crypto.getRandomValues(new Uint8Array(4))
    frame.set(mask, headerLength)
    for (let i = 0; i < length; i++) frame[headerLength + 4 + i] = payload[i] ^ mask[i & 3]
    this.writing = this.writing.then(
      () => this.socket.write(frame).then(() => {}),
      () => {},
    )
    this.writing.catch(() => this.finish(1006, '', false))
  }

  private async readLoop(): Promise<void> {
    try {
      for (;;) {
        while (this.parseFrame()) if (this.closed) return
        const chunk = await this.socket.read(64 * 1024)
        if (!chunk.length) break
        this.buffered = concat(this.buffered, chunk)
      }
    } catch {
      // Treated as an abnormal closure below.
    }
    this.finish(1006, '', false)
  }

  /** Handles one complete frame from the buffer; false when more bytes are needed. */
  private parseFrame(): boolean {
    const data = this.buffered
    if (data.length < 2) return false
    const fin = (data[0] & 0x80) !== 0
    const opcode = data[0] & 0x0f
    const masked = (data[1] & 0x80) !== 0
    let length = data[1] & 0x7f
    let offset = 2
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    if (length === 126) {
      if (data.length < 4) return false
      length = view.getUint16(2)
      offset = 4
    } else if (length === 127) {
      if (data.length < 10) return false
      length = Number(view.getBigUint64(2))
      offset = 10
    }
    if (length > MAX_MESSAGE) {
      this.protocolError(1009, 'message too big')
      return true
    }
    const maskOffset = offset
    if (masked) offset += 4
    if (data.length < offset + length) return false
    const payload = data.slice(offset, offset + length)
    if (masked) for (let i = 0; i < length; i++) payload[i] ^= data[maskOffset + (i & 3)]
    this.buffered = data.subarray(offset + length)

    switch (opcode) {
      case OP_TEXT:
      case OP_BINARY:
        this.fragmentType = opcode
        this.fragments = [payload]
        if (fin) this.deliver()
        break
      case OP_CONTINUATION:
        this.fragments.push(payload)
        if (fin) this.deliver()
        break
      case OP_PING:
        this.sendFrame(OP_PONG, payload)
        break
      case OP_PONG:
        break
      case OP_CLOSE: {
        const code = payload.length >= 2 ? new DataView(payload.buffer).getUint16(0) : 1005
        const reason = payload.length > 2 ? decoder.decode(payload.subarray(2)) : ''
        if (!this.closeSent) {
          this.sendFrame(OP_CLOSE, payload.subarray(0, 2))
          this.closeSent = true
        }
        void this.writing.then(() => this.finish(code, reason, true))
        this.closed = true
        break
      }
      default:
        this.protocolError(1002, `unknown opcode ${opcode}`)
    }
    return true
  }

  private deliver(): void {
    let size = 0
    for (const fragment of this.fragments) size += fragment.length
    const message = new Uint8Array(size)
    let offset = 0
    for (const fragment of this.fragments) {
      message.set(fragment, offset)
      offset += fragment.length
    }
    this.fragments = []
    this.handlers?.onMessage(this.fragmentType === OP_TEXT ? decoder.decode(message) : message)
  }

  private protocolError(code: number, reason: string): void {
    this.close(code, reason)
    this.closed = true
    this.finish(code, reason, false)
  }

  private finish(code: number, reason: string, wasClean: boolean): void {
    if (this.finished) return
    this.finished = true
    this.closed = true
    clearTimeout(this.closeTimer)
    this.socket.release()
    this.handlers?.onClose(code, reason, wasClean)
  }
}
