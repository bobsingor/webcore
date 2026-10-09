// Real Node.js (v24.21.0's own lib/) on the kernel: behaviour that depends on the bindings in
// src/personalities/node rather than on Node's JavaScript.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Kernel } from '../src/index.ts'
import { boot, sh } from './helpers.ts'

let kernel: Kernel

beforeEach(() => {
  kernel = boot()
})

afterEach(() => {
  kernel.shutdown()
})

const node = async (code: string) => sh(kernel, `node -e "${code.replace(/"/g, '\\"')}"`)
const print = async (expression: string) => (await sh(kernel, `node -p "${expression.replace(/"/g, '\\"')}"`)).stdout

describe('runtime', () => {
  it('identifies as Node v24.21.0 on Linux', async () => {
    expect(await print("[process.version, process.platform, process.arch, typeof process.versions.webcore].join(' ')")).toBe(
      'v24.21.0 linux wasm32 string\n',
    )
  })

  it('orders ticks, promises, immediates and timers like Node', async () => {
    const { stdout } = await node(
      "setTimeout(() => console.log('timeout'), 20); setImmediate(() => console.log('immediate')); process.nextTick(() => console.log('tick')); Promise.resolve().then(() => console.log('promise')); console.log('sync')",
    )
    expect(stdout).toBe('sync\ntick\npromise\nimmediate\ntimeout\n')
  })

  it('drains process.nextTick scheduled from a promise reaction', async () => {
    expect((await node("Promise.resolve().then(() => process.nextTick(() => console.log('drained')))")).stdout).toBe('drained\n')
  })

  it('formats uncaught errors with Node’s own reporter', async () => {
    const result = await node("throw new Error('boom')")
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^Error: boom\n {4}at \[eval\]:1:7\n/)
    expect(result.stderr).toMatch(/\n\nNode\.js v24\.21\.0\n$/)
    expect(result.stderr).not.toMatch(/https?:|file:/)
  })

  it('emits exit with process.exitCode', async () => {
    const result = await node("process.on('exit', (code) => console.log('exiting', code)); process.exitCode = 3")
    expect(result).toMatchObject({ code: 3, stdout: 'exiting 3\n' })
  })
})

describe('bindings', () => {
  it('implements URL parsing over the host parser (ada offsets)', async () => {
    expect(
      await print(
        "const u = new URL('https://user:pw@example.com:8080/a/b?q=1#h'); [u.protocol, u.username, u.password, u.hostname, u.port, u.pathname, u.search, u.hash, u.origin].join('|')",
      ),
    ).toBe('https:|user|pw|example.com|8080|/a/b|?q=1|#h|https://example.com:8080\n')
    expect(await print("require('url').pathToFileURL('/tmp/a b#c').href")).toBe('file:///tmp/a%20b%23c\n')
  })

  it('implements Buffer encodings, StringDecoder and TextDecoder', async () => {
    expect(await print("[Buffer.from('héllo').toString('base64'), Buffer.from('aMOpbGxv', 'base64').toString(), Buffer.byteLength('€')].join('|')")).toBe(
      'aMOpbGxv|héllo|3\n',
    )
    expect(
      await print(
        "const d = new (require('string_decoder').StringDecoder)('utf8'); d.write(Buffer.from([0xe2, 0x82])) + '+' + d.write(Buffer.from([0xac])) + '|' + new TextDecoder().decode(new Uint8Array([0xe2, 0x82, 0xac]))",
      ),
    ).toBe('+€|€\n')
  })

  it('streams files through fs.createReadStream', async () => {
    expect((await node("require('fs').createReadStream('/etc/hostname').pipe(process.stdout)")).stdout).toBe('webcore\n')
  })

  it('loads every builtin module except the ones scheduled for later milestones', async () => {
    const { stdout } = await node(
      "const failed = []; for (const id of require('module').builtinModules) { try { require(id) } catch { failed.push(id) } } console.log(failed.join(' '))",
    )
    const later = [
      // http_parser and virtual TCP (M1c)
      '_http_client', '_http_common', '_http_outgoing', '_http_server', 'http', 'http2',
      // crypto and zlib (M1d)
      '_tls_common', '_tls_wrap', 'crypto', 'https', 'tls', 'zlib',
      // vm contexts; V8 serializer
      'repl', 'node:test',
      // Like official builds without them
      'inspector', 'inspector/promises', 'trace_events',
    ]
    expect(stdout.trim().split(' ').sort()).toEqual(later.sort())
  })
})

describe('child_process', () => {
  it('pipes through a child with spawn', async () => {
    const { stdout } = await node("const c = require('child_process').spawn('wc'); c.stdout.pipe(process.stdout); c.stdin.end('one two three\\n')")
    expect(stdout).toBe('      1       3      14\n')
  })

  it('reports signals when a child is killed', async () => {
    const { stdout } = await node(
      "const c = require('child_process').spawn('node', ['-e', 'setInterval(() => {}, 1000)']); setTimeout(() => c.kill(), 100); c.on('exit', (code, signal) => console.log(code, signal))",
    )
    expect(stdout).toBe('null SIGTERM\n')
  })

  it('runs Node in Node with execFile and spawnSync', async () => {
    expect((await node("require('child_process').execFile('node', ['-p', '6 * 7'], (e, out) => console.log(e ? e.message : out.trim()))")).stdout).toBe(
      '42\n',
    )
    expect(
      (await node("const r = require('child_process').spawnSync('node', ['-e', 'setTimeout(() => {}, 5000)'], { timeout: 200 }); console.log(r.status, r.signal)"))
        .stdout,
    ).toBe('null SIGTERM\n')
  })

  it('reports ENOENT for unknown commands', async () => {
    expect((await node("const r = require('child_process').spawnSync('nope'); console.log(r.error.code, r.error.message)")).stdout).toBe(
      'ENOENT spawnSync nope ENOENT\n',
    )
  })
})
