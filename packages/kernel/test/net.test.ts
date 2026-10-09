// Virtual TCP (M1c): kernel sockets, Node's net and http modules on top of them, and HTTP from the
// host into the kernel (what the preview bridge does).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ENV, KernelError, kernelFetch, readBody, type Kernel, type KernelEvent, type Process } from '../src/index.ts'
import { boot, sh } from './helpers.ts'

let kernel: Kernel
const encoder = new TextEncoder()
const decoder = new TextDecoder()

beforeEach(() => {
  kernel = boot()
})

afterEach(() => {
  kernel.shutdown()
})

function files(tree: Record<string, string>): void {
  for (const [path, content] of Object.entries(tree)) kernel.fs.writeFile(`/home/user/${path}`, content)
}

/** Starts `node <script>` in the background and resolves once it listens on `port`. */
async function serve(script: string, port: number): Promise<Process> {
  const [reader, writer] = kernel.pipe()
  let output = ''
  void (async () => {
    for (let chunk = await reader.read(4096); chunk.length; chunk = await reader.read(4096)) output += decoder.decode(chunk)
    reader.release()
  })()
  const listening = new Promise<void>((resolve) => {
    const off = kernel.events.subscribe((event) => {
      if (event.type === 'net.listen' && event.port === port) {
        off()
        resolve()
      }
    })
  })
  const proc = kernel.spawn(['node', script], { cwd: '/home/user', env: { ...DEFAULT_ENV }, stdio: [undefined, writer, writer] })
  writer.release()
  await Promise.race([
    listening,
    proc.exited.then((code) => Promise.reject(new Error(`server exited with ${code} before listening:\n${output}`))),
  ])
  return proc
}

async function text(port: number, request: Parameters<typeof kernelFetch>[2] = {}) {
  const response = await kernelFetch(kernel, port, request)
  return { ...response, text: decoder.decode(await readBody(response.body)) }
}

describe('kernel sockets', () => {
  it('connects, carries data both ways, half-closes and closes', async () => {
    const listener = kernel.net.listen('127.0.0.1', 8080, 0)
    const client = kernel.connect(8080)
    const server = await listener.accept()
    expect(server.peer).toEqual(client.local)
    expect(client.peer).toEqual({ address: '127.0.0.1', family: 'IPv4', port: 8080 })

    await client.write(encoder.encode('ping'))
    expect(decoder.decode(await server.read(100))).toBe('ping')
    client.shutdown()
    expect((await server.read(100)).length).toBe(0) // EOF, but the server can still write
    await server.write(encoder.encode('pong'))
    expect(decoder.decode(await client.read(100))).toBe('pong')

    server.release()
    expect((await client.read(100)).length).toBe(0)
    client.release()
    listener.release()
  })

  it('refuses connections nobody listens for, and ports already taken', () => {
    expect(() => kernel.connect(9)).toThrowError(expect.objectContaining({ errno: 111 }) as KernelError)
    const listener = kernel.net.listen('::', 3000, 0)
    expect(() => kernel.net.listen('0.0.0.0', 3000, 0)).toThrowError(/EADDRINUSE/)
    expect(() => kernel.net.listen('10.0.0.1', 3001, 0)).toThrowError(/EADDRNOTAVAIL/)
    expect(() => kernel.connect(3000, '93.184.216.34')).toThrowError(/ENETUNREACH/)
    listener.release()
    expect(() => kernel.connect(3000)).toThrowError(/ECONNREFUSED/)
  })

  it('reports listening ports, and closes them when their process exits', async () => {
    const events: KernelEvent[] = []
    kernel.events.subscribe((event) => event.type.startsWith('net.') && events.push(event))
    files({ 'idle.js': "require('net').createServer().listen(0, () => setTimeout(() => process.exit(0), 50))" })
    const result = await sh(kernel, 'node idle.js')
    expect(result.code).toBe(0)
    expect(events.map((event) => event.type)).toEqual(['net.listen', 'net.close'])
    expect(events[0]).toMatchObject({ address: '::' })
    expect((events[0] as { port: number }).port).toBeGreaterThanOrEqual(32768)
    expect(kernel.net.listening).toEqual([])
  })
})

describe('node:net', () => {
  it('talks between processes over localhost', async () => {
    files({
      'server.js': [
        "const server = require('net').createServer((socket) => {",
        "  socket.on('data', (data) => socket.end(`echo ${data} from ${socket.remoteFamily}`))",
        '})',
        'server.listen(4000)',
      ].join('\n'),
      'client.js': [
        "const socket = require('net').connect(4000, 'localhost')",
        "socket.on('connect', () => socket.write('hi'))",
        "socket.setEncoding('utf8').on('data', (data) => console.log(data, socket.remoteAddress, socket.remotePort))",
      ].join('\n'),
    })
    await serve('server.js', 4000)
    const result = await sh(kernel, 'node client.js')
    expect(result.stdout).toBe('echo hi from IPv6 127.0.0.1 4000\n')
  })

  it('reports EADDRINUSE and ECONNREFUSED like Node', async () => {
    files({
      'server.js': "require('net').createServer().listen(4001)",
      'twice.js': "require('net').createServer().listen(4001).on('error', (e) => console.log(e.code, e.message))",
      // localhost has two addresses, so Node tries both and reports an AggregateError.
      'refused.js': "require('net').connect(4999).on('error', (e) => console.log(e.code, e.errors.map((x) => x.message).join(' / ')))",
      'dns.js': [
        "const dns = require('dns')",
        "dns.lookup('localhost', { all: true }, (err, all) => console.log(JSON.stringify(all)))",
        "dns.lookup('example.com', (err) => console.log(err.code, err.message))",
      ].join('\n'),
    })
    await serve('server.js', 4001)
    expect((await sh(kernel, 'node twice.js')).stdout).toBe('EADDRINUSE listen EADDRINUSE: address already in use :::4001\n')
    expect((await sh(kernel, 'node refused.js')).stdout).toBe(
      'ECONNREFUSED connect ECONNREFUSED 127.0.0.1:4999 / connect ECONNREFUSED ::1:4999\n',
    )
    expect((await sh(kernel, 'node dns.js')).stdout).toBe(
      '[{"address":"127.0.0.1","family":4},{"address":"::1","family":6}]\nENOTFOUND getaddrinfo ENOTFOUND example.com\n',
    )
  })
})

describe('node:http', () => {
  beforeEach(() => {
    files({
      'server.js': [
        "const http = require('http')",
        'http.createServer((req, res) => {',
        "  if (req.url === '/stream') {",
        "    res.writeHead(200, { 'content-type': 'text/plain' })",
        "    let n = 0; const timer = setInterval(() => { res.write(`tick ${++n}\\n`); if (n === 3) { clearInterval(timer); res.end() } }, 5)",
        '    return',
        '  }',
        "  let body = ''",
        "  req.on('data', (chunk) => (body += chunk)).on('end', () => {",
        "    res.statusCode = req.url === '/missing' ? 404 : 200",
        "    res.setHeader('set-cookie', ['a=1', 'b=2'])",
        "    res.end(`${req.method} ${req.url} host=${req.headers.host} body=${body}`)",
        '  })',
        '}).listen(3000)',
      ].join('\n'),
    })
  })

  it('serves the host, like a preview would', async () => {
    await serve('server.js', 3000)
    const get = await text(3000, { path: '/hello?x=1', headers: { host: 'p3000.localhost:5180', accept: 'text/html' } })
    expect(get.status).toBe(200)
    expect(get.text).toBe('GET /hello?x=1 host=p3000.localhost:5180 body=')
    expect(get.headers.filter(([name]) => name.toLowerCase() === 'set-cookie')).toEqual([
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
    ])

    expect((await text(3000, { method: 'POST', path: '/form', body: 'a=b' })).text).toBe('POST /form host=localhost:3000 body=a=b')
    expect((await text(3000, { path: '/missing' })).status).toBe(404)
    const head = await text(3000, { method: 'HEAD' })
    expect([head.status, head.text]).toEqual([200, ''])

    // Streamed responses arrive as they are written, not when they end.
    const stream = await kernelFetch(kernel, 3000, { path: '/stream' })
    const reader = stream.body.getReader()
    expect(decoder.decode((await reader.read()).value)).toBe('tick 1\n')
    let rest = ''
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += decoder.decode(chunk.value)
    expect(rest).toBe('tick 2\ntick 3\n')
  })

  it('serves other Node processes, and http.get fails cleanly for the outside world', async () => {
    await serve('server.js', 3000)
    files({
      'client.mjs': [
        "import http from 'node:http'",
        "const get = (url) => new Promise((resolve, reject) => http.get(url, (res) => { let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve(`${res.statusCode} ${s}`)) }).on('error', reject))",
        "console.log(await get('http://localhost:3000/a'))",
        "console.log(await get('http://127.0.0.1:3000/b'))",
        "console.log(await get('http://example.com/').catch((e) => e.code))",
        'const res = await fetch("http://localhost:3000/").catch((e) => e.name)',
        'console.log(typeof res)',
      ].join('\n'),
    })
    const result = await sh(kernel, 'node client.mjs')
    expect(result.stdout.split('\n').slice(0, 3)).toEqual([
      '200 GET /a host=localhost:3000 body=',
      '200 GET /b host=127.0.0.1:3000 body=',
      'ENOTFOUND',
    ])
    expect(result.code).toBe(0)
  })

  it('rejects malformed requests with 400 and keeps serving', async () => {
    await serve('server.js', 3000)
    const socket = kernel.connect(3000)
    await socket.write(encoder.encode('BREW /pot HTTP/1.1\r\n\r\n'))
    let reply = ''
    for (let chunk = await socket.read(4096); chunk.length; chunk = await socket.read(4096)) reply += decoder.decode(chunk)
    socket.release()
    expect(reply).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/)
    expect((await text(3000)).status).toBe(200)
  })
})
