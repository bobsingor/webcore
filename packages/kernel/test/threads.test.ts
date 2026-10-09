// M1e: worker_threads over kernel threads, node:wasi, file watching and the V8 serializer.
// Expected output is real Node's (Linux semantics where file watching differs by platform).
import { serialize } from 'node:v8'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Kernel } from '../src/index.ts'
import { boot, sh, wasiFixtures } from './helpers.ts'

let kernel: Kernel

beforeEach(() => {
  kernel = boot()
})

afterEach(() => {
  kernel.shutdown()
})

/** Writes `source` to /home/user/<name> and runs it with node. */
async function run(name: string, source: string) {
  kernel.writeFile(`/home/user/${name}`, source)
  return sh(kernel, `node ${name}`)
}

describe('worker_threads', () => {
  it('exchanges messages, transfers buffers and ports, and receives synchronously', async () => {
    const { stdout } = await run(
      'messages.mjs',
      `import { Worker, isMainThread, parentPort, workerData, threadId, MessageChannel, receiveMessageOnPort } from 'node:worker_threads'
      if (isMainThread) {
        const worker = new Worker(new URL(import.meta.url), { workerData: { n: 21 } })
        const { port1, port2 } = new MessageChannel()
        port1.postMessage({ a: 1 })
        console.log('sync receive', JSON.stringify(receiveMessageOnPort(port2)), receiveMessageOnPort(port2))
        const buf = new ArrayBuffer(8)
        worker.postMessage({ hello: 'ping', buf, port: port2 }, [buf, port2])
        console.log('transferred', buf.byteLength)
        port1.on('message', (message) => { console.log('via port', message); port1.close() })
        worker.on('message', (message) => console.log('reply', JSON.stringify(message)))
        worker.on('exit', (code) => console.log('exit', code))
      } else {
        parentPort.once('message', ({ hello, buf, port }) => {
          port.postMessage('from thread ' + threadId)
          port.close()
          parentPort.postMessage({ hello, bytes: buf.byteLength, doubled: workerData.n * 2 })
        })
      }`,
    )
    // Node orders a thread's parentPort messages before 'exit', but not other ports' messages.
    const lines = stdout.split('\n')
    expect(lines.filter((line) => !line.startsWith('via port'))).toEqual([
      'sync receive {"message":{"a":1}} undefined',
      'transferred 0',
      'reply {"hello":"ping","bytes":8,"doubled":42}',
      'exit 0',
      '',
    ])
    expect(lines).toContain('via port from thread 1')
  })

  it('reports exit codes, termination, errors and shares memory', async () => {
    const { stdout } = await run(
      'exits.js',
      `const { Worker } = require('node:worker_threads')
      const { once } = require('node:events')
      ;(async () => {
        const [code] = await once(new Worker('process.exit(7)', { eval: true }), 'exit')
        console.log('process.exit in a thread', code)
        const looping = new Worker('setInterval(() => {}, 1000)', { eval: true })
        await once(looping, 'online')
        const [[terminated]] = await Promise.all([once(looping, 'exit'), looping.terminate()])
        console.log('terminated', terminated)
        const failing = new Worker('const e = new RangeError("boom"); e.code = "E_BOOM"; throw e', { eval: true })
        const [error] = await once(failing, 'error')
        console.log('error', error instanceof RangeError, error.message, error.code)
        const sab = new SharedArrayBuffer(4)
        const shared = new Worker('const a = new Int32Array(require("worker_threads").workerData); Atomics.store(a, 0, 42)', { eval: true, workerData: sab })
        await once(shared, 'exit')
        console.log('shared memory', Atomics.load(new Int32Array(sab), 0))
      })()`,
    )
    expect(stdout).toBe('process.exit in a thread 7\nterminated 1\nerror true boom E_BOOM\nshared memory 42\n')
  })

  it("delivers everything a thread posted before 'exit'", async () => {
    // parentPort is its own channel, so its messages race the exit notice unless the parent waits.
    kernel.writeFile(
      '/home/user/flood.js',
      `const { Worker } = require('node:worker_threads')
      const results = []
      for (let k = 0; k < 4; k++) {
        let received = 0
        const worker = new Worker('for (let i = 0; i < 200; i++) require("worker_threads").parentPort.postMessage(i)', { eval: true })
        worker.on('message', () => received++)
        worker.on('exit', () => { results.push(received); if (results.length === 4) console.log(results.join(' ')) })
      }`,
    )
    const runs = await Promise.all(Array.from({ length: 4 }, () => sh(kernel, 'node flood.js')))
    expect(runs.map((result) => result.stdout)).toEqual(Array(4).fill('200 200 200 200\n'))
  })
})

describe('node:wasi', () => {
  it('runs WASI programs with preopened directories', async () => {
    for (const [name, bytes] of Object.entries(await wasiFixtures())) kernel.fs.writeFile(`/usr/bin/${name}`, bytes, 0o755)
    const { stdout } = await run(
      'wasi.js',
      `const { WASI } = require('node:wasi')
      const fs = require('node:fs')
      const run = (file, args) => {
        const wasi = new WASI({ version: 'preview1', args, env: {}, preopens: { '/': process.cwd() }, returnOnExit: true })
        const instance = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(file)), wasi.getImportObject())
        return wasi.start(instance)
      }
      fs.writeFileSync('note.txt', 'read through a preopen\\n')
      console.log('echo exit', run('/usr/bin/wasi-echo', ['echo', 'hello', 'from', 'wasi']))
      console.log('cat exit', run('/usr/bin/wasi-cat', ['cat', '/note.txt']))
      console.log('missing exit', run('/usr/bin/wasi-cat', ['cat', '/missing.txt']))`,
    )
    expect(stdout).toBe('hello from wasi\necho exit 0\nread through a preopen\ncat exit 0\nmissing exit 1\n')
  })

  it('keeps a process alive while WebAssembly compiles', async () => {
    const { stdout } = await run(
      'compile.js',
      `const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
      WebAssembly.compile(bytes).then((module) => console.log('compiled', module instanceof WebAssembly.Module))`,
    )
    expect(stdout).toBe('compiled true\n')
  })
})

describe('file watching', () => {
  it('reports entries with fs.watch, recursively on request', async () => {
    const { stdout } = await run(
      'watch.js',
      `const fs = require('node:fs')
      fs.mkdirSync('w/sub', { recursive: true })
      const seen = []
      const watcher = fs.watch('w', (event, name) => {
        seen.push(event + ' ' + name)
        if (seen.length === 2) { watcher.close(); console.log(seen.join(', ')) }
      })
      const deep = fs.watch('w', { recursive: true }, (event, name) => {
        if (name.includes('/')) { console.log('recursive', event, name); deep.close() }
      })
      fs.writeFileSync('w/sub/deep.txt', 'x')
      fs.writeFileSync('w/new.txt', 'x')`,
    )
    // inotify: a new file is created, then modified. The non-recursive watch doesn't see sub/.
    expect(stdout.split('\n').sort()).toEqual(['', 'recursive rename sub/deep.txt', 'rename new.txt, change new.txt'])
  })

  it('iterates fs.promises.watch until aborted, and polls with fs.watchFile', async () => {
    const { stdout } = await run(
      'watch.mjs',
      `import fs from 'node:fs'
      import { watch } from 'node:fs/promises'
      fs.mkdirSync('aw')
      const ac = new AbortController()
      setImmediate(() => fs.writeFileSync('aw/x.txt', 'x'))
      try {
        for await (const { eventType, filename } of watch('aw', { signal: ac.signal })) { console.log(eventType, filename); ac.abort() }
      } catch (error) { console.log(error.name) }
      fs.writeFileSync('f.txt', '1')
      fs.watchFile('f.txt', { interval: 10 }, (current, previous) => { console.log('watchFile', previous.size, '->', current.size); fs.unwatchFile('f.txt') })
      setTimeout(() => fs.writeFileSync('f.txt', '123'), 30)`,
    )
    expect(stdout).toBe('rename x.txt\nAbortError\nwatchFile 1 -> 3\n')
  })
})

describe('v8 serializer', () => {
  it('writes the same bytes as V8 and reads them back', async () => {
    const values = `[
      [undefined, null, true, 0, -1, 2 ** 31 - 1, 2 ** 31, 1.5, -0, NaN],
      [0n, -1n, 2n ** 64n],
      ['', 'héllo', 'snow ☃'],
      { a: 1, 3: 'three', nested: { deep: [1, , 3] } },
      new Date(0), /a+b/gi, new Map([[1, 'one']]), new Set(['x']),
      [Object(1.5), Object('str')], Buffer.from('buf'), new Float64Array([1.5]), new ArrayBuffer(2),
    ]`
    const expected = serialize(new Function(`return ${values}`)()).toString('hex')
    const { stdout } = await sh(
      kernel,
      `node -e "const v8 = require('v8'); const util = require('util'); const value = ${values.replace(/\n/g, ' ')}; const bytes = v8.serialize(value); console.log(bytes.toString('hex')); console.log(util.isDeepStrictEqual(v8.deserialize(bytes), value))"`,
    )
    expect(stdout).toBe(`${expected}\ntrue\n`)
  })

  it('runs node:test', async () => {
    kernel.writeFile(
      '/home/user/math.test.mjs',
      `import { test } from 'node:test'
      import assert from 'node:assert/strict'
      test('adds', () => assert.equal(1 + 1, 2))
      test('fails', () => assert.equal(1, 2))`,
    )
    const { code, stdout } = await sh(kernel, 'node --test --test-reporter=dot math.test.mjs')
    expect(code).toBe(1)
    expect(stdout).toMatch(/^\.X\n/)
    expect(stdout).toMatch(/Expected values to be strictly equal/)
  })
})
