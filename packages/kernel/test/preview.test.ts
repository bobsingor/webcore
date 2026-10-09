// The preview bridge (M1c), driven over a MessageChannel as the Service Worker and the injected
// client script drive it in a browser.
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ENV, PreviewBridge, type Kernel, type MessagePortLike, type PreviewReply, type PreviewRequest } from '../src/index.ts'
import { boot } from './helpers.ts'

let kernel: Kernel
let bridge: PreviewBridge
const decoder = new TextDecoder()
const origin = (port: number) => `http://p${port}.localhost:5180`

beforeEach(() => {
  kernel = boot()
  bridge = new PreviewBridge(kernel, { origin })
})

afterEach(() => {
  kernel.shutdown()
})

// A plain http server, plus a WebSocket echo server on the same port via the 'upgrade' event. The
// handshake needs SHA-1, and node:crypto arrives in M1d, so the fixture brings its own.
const SERVER = String.raw`
const http = require('http')
function sha1(message) {
  const total = Math.ceil((message.length + 9) / 64) * 64
  const data = new Uint8Array(total)
  data.set(message)
  data[message.length] = 0x80
  const view = new DataView(data.buffer)
  view.setUint32(total - 4, message.length * 8)
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]
  const w = new Uint32Array(80)
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31) }
    let [a, b, c, d, e] = h
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = t
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0; h[4] = (h[4] + e) >>> 0
  }
  const out = Buffer.alloc(20)
  h.forEach((value, i) => out.writeUInt32BE(value, i * 4))
  return out
}
const frame = (opcode, payload) => Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload])

const server = http.createServer((req, res) => {
  if (req.url === '/page') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end('<!doctype html><html><head><title>t</title></head><body>hi</body></html>')
  }
  if (req.url === '/login') {
    res.setHeader('set-cookie', ['session=abc; Path=/; HttpOnly', 'theme=dark'])
    return res.end('ok')
  }
  if (req.url === '/logout') {
    res.setHeader('set-cookie', 'theme=; Max-Age=0')
    return res.end('bye')
  }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, cookie: req.headers.cookie ?? null, accept: req.headers['accept-encoding'] ?? null }))
})
server.on('upgrade', (req, socket, head) => {
  const accept = sha1(Buffer.from(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')).toString('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: echo\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
  socket.write(frame(1, Buffer.from('hello ' + req.url + ' from ' + req.headers.origin)))
  let buffer = head
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data])
    while (buffer.length >= 6) {
      const opcode = buffer[0] & 0x0f
      const length = buffer[1] & 0x7f
      if (buffer.length < 6 + length) return
      const mask = buffer.subarray(2, 6)
      const payload = Buffer.from(buffer.subarray(6, 6 + length).map((byte, i) => byte ^ mask[i & 3]))
      buffer = buffer.subarray(6 + length)
      if (opcode === 8) return socket.end(frame(8, payload))
      socket.write(frame(opcode, Buffer.concat([Buffer.from(opcode === 1 ? 'echo:' : ''), payload])))
    }
  })
})
server.listen(3100)
`

async function serve(): Promise<void> {
  kernel.fs.writeFile('/home/user/server.js', SERVER)
  const listening = new Promise<void>((resolve) => {
    const off = kernel.events.subscribe((event) => {
      if (event.type === 'net.listen') {
        off()
        resolve()
      }
    })
  })
  kernel.spawn(['node', 'server.js'], { cwd: '/home/user', env: { ...DEFAULT_ENV } })
  await listening
}

/** A channel to the bridge, as the Service Worker would hold it. */
function connect() {
  const { port1, port2 } = new MessageChannel()
  bridge.serve(port1 as unknown as MessagePortLike)
  const replies: PreviewReply[] = []
  const waiters: (() => void)[] = []
  port2.on('message', (message: PreviewReply) => {
    replies.push(message)
    for (const wake of waiters.splice(0)) wake()
  })
  const send = (message: PreviewRequest) => (port2 as MessagePort).postMessage(message)
  const next = async (predicate: (reply: PreviewReply) => boolean): Promise<PreviewReply> => {
    for (;;) {
      const index = replies.findIndex(predicate)
      if (index >= 0) return replies.splice(index, 1)[0]
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
  }
  const fetch = async (id: number, url: string, navigate = false, headers: [string, string][] = []) => {
    send({ type: 'fetch', id, port: 3100, method: 'GET', url, host: 'p3100.localhost:5180', headers, navigate })
    const head = (await next((reply) => reply.id === id && (reply.type === 'head' || reply.type === 'error'))) as Extract<PreviewReply, { type: 'head' }>
    let body = ''
    for (;;) {
      const reply = await next((r) => r.id === id && (r.type === 'chunk' || r.type === 'end'))
      if (reply.type === 'end') break
      if (reply.type === 'chunk') body += decoder.decode(reply.data)
    }
    return { ...head, body }
  }
  return { send, next, fetch, close: () => port2.close() }
}

describe('preview bridge', () => {
  it('answers requests from the server on the preview port, with the preview host', async () => {
    await serve()
    const channel = connect()
    const api = await channel.fetch(1, '/api?q=1', false, [['Accept-Encoding', 'gzip, br'], ['Accept', '*/*']])
    expect(api.status).toBe(200)
    expect(JSON.parse(api.body)).toEqual({ method: 'GET', url: '/api?q=1', host: 'p3100.localhost:5180', cookie: null, accept: null })

    // Navigations to HTML get the client script, first thing in <head>.
    const page = await channel.fetch(2, '/page', true)
    expect(page.body).toBe('<!doctype html><html><head><script src="/__webcore/client.js"></script><title>t</title></head><body>hi</body></html>')
    expect(page.headers.some(([name]) => name.toLowerCase() === 'content-length')).toBe(false)
    channel.close()
  })

  it('keeps cookies for the preview, since Service Worker responses cannot set them', async () => {
    await serve()
    const channel = connect()
    const login = await channel.fetch(1, '/login')
    expect(login.headers.some(([name]) => name.toLowerCase() === 'set-cookie')).toBe(false)
    expect(JSON.parse((await channel.fetch(2, '/me')).body).cookie).toBe('session=abc; theme=dark')
    await channel.fetch(3, '/logout')
    expect(JSON.parse((await channel.fetch(4, '/me')).body).cookie).toBe('session=abc')
    channel.close()
  })

  it('explains, and keeps retrying, while nothing listens on the port', async () => {
    const channel = connect()
    const page = await channel.fetch(1, '/', true)
    expect(page.status).toBe(502)
    expect(page.body).toContain('Nothing is listening on port 3100')
    expect(page.body).toContain('http-equiv="refresh"')
    channel.close()
  })

  it('relays WebSockets to the server', async () => {
    await serve()
    const channel = connect()
    channel.send({ type: 'ws-open', id: 7, port: 3100, url: '/hmr?token=1', host: 'p3100.localhost:5180', protocols: ['echo'], origin: origin(3100) })
    expect(await channel.next((reply) => reply.type === 'ws-open')).toMatchObject({ id: 7, protocol: 'echo' })
    expect(await channel.next((reply) => reply.type === 'ws-message')).toMatchObject({ data: 'hello /hmr?token=1 from http://p3100.localhost:5180' })
    channel.send({ type: 'ws-send', id: 7, data: 'ping' })
    expect(await channel.next((reply) => reply.type === 'ws-message')).toMatchObject({ data: 'echo:ping' })
    channel.send({ type: 'ws-send', id: 7, data: new Uint8Array([1, 2, 3]).buffer })
    const binary = await channel.next((reply) => reply.type === 'ws-message')
    expect(new Uint8Array((binary as { data: ArrayBuffer }).data)).toEqual(new Uint8Array([1, 2, 3]))
    channel.send({ type: 'ws-close', id: 7, code: 1000, reason: 'done' })
    expect(await channel.next((reply) => reply.type === 'ws-close')).toMatchObject({ code: 1000, wasClean: true })
    channel.close()
  })

  it('only accepts channels from its own preview origins', () => {
    const target = new EventTarget()
    let served = 0
    bridge.serve = () => void served++
    bridge.listen(target)
    const post = (from: string) => {
      const { port1 } = new MessageChannel()
      target.dispatchEvent(new MessageEvent('message', { data: { type: 'webcore:connect' }, origin: from, ports: [port1 as never] }))
      port1.close()
    }
    post('http://evil.example')
    post('http://p3100.localhost:9999')
    post('null')
    expect(served).toBe(0)
    post(origin(3100))
    expect(served).toBe(1)
    expect(bridge.url(3100, '/a b')).toBe('http://p3100.localhost:5180/__webcore/boot.html?path=%2Fa%20b')
  })
})
