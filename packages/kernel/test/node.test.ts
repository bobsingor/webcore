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
    // As in Node, an expired timer runs before immediates, so the delay must outlast a busy machine.
    const { stdout } = await node(
      "setTimeout(() => console.log('timeout'), 100); setImmediate(() => console.log('immediate')); process.nextTick(() => console.log('tick')); Promise.resolve().then(() => console.log('promise')); console.log('sync')",
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

  it('creates and resolves symbolic links, for fs and for module loading', async () => {
    kernel.fs.mkdirp('/home/user/pkg/lib')
    kernel.fs.writeFile('/home/user/pkg/lib/index.js', "module.exports = __filename + ' ' + require('./sibling')")
    kernel.fs.writeFile('/home/user/pkg/lib/sibling.js', "module.exports = 'sibling'")
    const result = await node(
      [
        "const fs = require('fs')",
        "fs.mkdirSync('node_modules')",
        "fs.symlinkSync('../pkg/lib', 'node_modules/linked')",
        "console.log(fs.readlinkSync('node_modules/linked'), fs.lstatSync('node_modules/linked').isSymbolicLink(), fs.statSync('node_modules/linked').isDirectory())",
        "console.log(fs.realpathSync('node_modules/linked/index.js'), fs.realpathSync.native('node_modules/linked'))",
        "console.log(require('linked'))",
        "console.log(fs.readdirSync('node_modules', { withFileTypes: true }).map((d) => d.name + ':' + d.isSymbolicLink()))",
        "fs.rmSync('node_modules', { recursive: true })",
        "console.log(fs.existsSync('pkg/lib/index.js'), fs.existsSync('node_modules'))",
      ].join('; '),
    )
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(
      [
        '../pkg/lib true true',
        '/home/user/pkg/lib/index.js /home/user/pkg/lib',
        '/home/user/pkg/lib/index.js sibling',
        '[ \'linked:true\' ]',
        'true false',
        '',
      ].join('\n'),
    )
  })

  it('runs a program through a symlinked bin, like node_modules/.bin', async () => {
    kernel.fs.mkdirp('/home/user/node_modules/tool/bin')
    kernel.fs.mkdirp('/home/user/node_modules/.bin')
    kernel.fs.writeFile('/home/user/node_modules/tool/bin/cli.mjs', '#!/usr/bin/env node\nconsole.log(process.argv[1], import.meta.url, process.argv[2])\n', 0o755)
    kernel.fs.symlink('../tool/bin/cli.mjs', '/home/user/node_modules/.bin/tool')
    expect((await sh(kernel, 'node_modules/.bin/tool arg')).stdout).toBe(
      '/home/user/node_modules/.bin/tool file:///home/user/node_modules/tool/bin/cli.mjs arg\n',
    )
  })

  it('streams files through fs.createReadStream', async () => {
    expect((await node("require('fs').createReadStream('/etc/hostname').pipe(process.stdout)")).stdout).toBe('webcore\n')
  })

  it('loads every builtin module except the ones scheduled for later milestones', async () => {
    const { stdout } = await node(
      "const failed = []; for (const id of require('module').builtinModules) { try { require(id) } catch { failed.push(id) } } console.log(failed.join(' '))",
    )
    const later = [
      // nghttp2 (not scheduled yet)
      'http2',
      // vm contexts; V8 serializer
      'repl', 'node:test',
      // Like official builds without them
      'inspector', 'inspector/promises', 'trace_events',
    ]
    expect(stdout.trim().split(' ').sort()).toEqual(later.sort())
  })
})

describe('crypto', () => {
  it('hashes, signs and derives like OpenSSL, sync, async and through WebCrypto', async () => {
    const result = await node(
      [
        "const crypto = require('crypto')",
        "console.log(crypto.createHash('sha256').update('hello').digest('hex'))",
        "console.log(crypto.hash('md5', 'hello'), crypto.createHmac('sha1', 'key').update('data').digest('base64'))",
        "console.log(crypto.pbkdf2Sync('pw', 'salt', 100, 16, 'sha512').toString('hex'))",
        "console.log(crypto.randomUUID().length, crypto.timingSafeEqual(Buffer.from('a'), Buffer.from('a')))",
        "crypto.subtle.digest('SHA-1', new Uint8Array([1])).then((d) => console.log(Buffer.from(d).toString('hex')))",
      ].join('; '),
    )
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(
      [
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        '5d41402abc4b2a76b9719d911017c592 EEFSxb/coHvGM+69RhmfAlXJ9J0=',
        '3a3c4d6f183d46cd82a4f3b4e774514d',
        '36 true',
        'bf8b4530d8d246dd74ac53a13471bba17941dff7',
        '',
      ].join('\n'),
    )
  })

  it('reports what needs OpenSSL with Node’s own error codes', async () => {
    const result = await node(
      [
        "const crypto = require('crypto')",
        "const code = (fn) => { try { fn() } catch (e) { return e.code ?? e.message } }",
        "console.log(code(() => crypto.createCipheriv('aes-128-cbc', Buffer.alloc(16), Buffer.alloc(16))))",
        "console.log(code(() => crypto.createSign('sha256').update('x').sign('key')), code(() => crypto.scryptSync('a', 'b', 8)))",
        "console.log(code(() => crypto.createHash('whirlpool')), code(() => crypto.createHmac('whirlpool', 'k')))",
      ].join('; '),
    )
    expect(result.stdout).toBe(
      'ERR_CRYPTO_UNKNOWN_CIPHER\nERR_FEATURE_UNAVAILABLE_ON_PLATFORM ERR_CRYPTO_SCRYPT_NOT_SUPPORTED\nDigest method not supported ERR_CRYPTO_INVALID_DIGEST\n',
    )
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
