// End-to-end: real Workers, real Wasm, real syscalls, running headless in Node (ADR-0011).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exec, type Kernel, type KernelEvent } from '../src/index.ts'
import { boot, sh } from './helpers.ts'

let kernel: Kernel

beforeEach(() => {
  kernel = boot()
})

afterEach(() => {
  kernel.shutdown()
})

const UPPERCASE = `node -e "process.stdin.on('data', (d) => process.stdout.write(d.toString().toUpperCase()))"`

describe('personalities', () => {
  it('runs a WASI binary', async () => {
    expect(await sh(kernel, 'echo hello world')).toMatchObject({ code: 0, stdout: 'hello world\n' })
  })

  it('runs JavaScript with node -e and node -p', async () => {
    expect((await sh(kernel, `node -e "console.log('sum:', 1 + 2, { ok: true })"`)).stdout).toBe('sum: 3 { ok: true }\n')
    expect((await sh(kernel, 'node -p "[1, 2, 3].map((n) => n * 2)"')).stdout).toBe('[ 2, 4, 6 ]\n')
  })

  it('pipes WASI → JavaScript → WASI through kernel pipes', async () => {
    expect((await sh(kernel, `echo hello webcore | ${UPPERCASE}`)).stdout).toBe('HELLO WEBCORE\n')
    expect((await sh(kernel, `echo hello webcore | ${UPPERCASE} | wc`)).stdout).toBe('      1       2      14\n')
  })

  it('shares one filesystem across personalities', async () => {
    const events: KernelEvent[] = []
    kernel.events.subscribe((event) => events.push(event))
    const result = await sh(kernel, `node -e "require('fs').writeFileSync('note.txt', 'from node\\n')" && cat note.txt`)
    expect(result.stdout).toBe('from node\n')
    expect(events).toContainEqual(expect.objectContaining({ type: 'fs.change', op: 'create', path: '/home/user/note.txt' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'fs.change', op: 'write', path: '/home/user/note.txt' }))
  })

  it('lists directories through fd_readdir', async () => {
    expect((await sh(kernel, 'ls /usr/bin')).stdout).toBe('cat\necho\nls\nnode\nwc\n')
  })

  it('reads stdin synchronously and asynchronously from JavaScript', async () => {
    const sync = await sh(kernel, `echo a b c | node -e "console.log(require('fs').readFileSync(0, 'utf8').trim().split(' ').length)"`)
    expect(sync.stdout).toBe('3\n')
    // Pipes carry bytes, not messages, so the script must not assume chunk boundaries.
    const iterated = await sh(
      kernel,
      `echo x y | node -e "(async () => { let s = ''; for await (const c of process.stdin) s += c; console.log('got', JSON.stringify(s)) })()"`,
    )
    expect(iterated.stdout).toBe('got "x y\\n"\n')
  })

  it('uses async syscalls for fs.promises', async () => {
    const result = await sh(kernel, `node -e "require('fs').promises.readFile('/etc/hostname', 'utf8').then((s) => console.log('host=' + s.trim()))"`)
    expect(result.stdout).toBe('host=webcore\n')
  })
})

describe('processes', () => {
  it('spawns processes from processes (child_process.spawnSync)', async () => {
    const script = `const r = require('child_process').spawnSync('echo', ['from', 'wasi']); console.log(r.status, JSON.stringify(r.stdout.toString()))`
    expect((await sh(kernel, `node -e "${script}"`)).stdout).toBe('0 "from wasi\\n"\n')
  })

  it('propagates exit codes and errors', async () => {
    expect((await sh(kernel, 'node -e "process.exit(3)"')).code).toBe(3)

    const thrown = await sh(kernel, `node -e "throw new Error('boom')"`)
    expect(thrown.code).toBe(1)
    expect(thrown.stderr).toContain('Error: boom')

    expect(await sh(kernel, 'cat /nope')).toMatchObject({ code: 1, stderr: 'cat: /nope: No such file or directory\n' })
    expect(await sh(kernel, 'nosuchcmd')).toMatchObject({ code: 127, stderr: 'sh: nosuchcmd: command not found\n' })
  })

  it('keeps a JavaScript process alive while timers are pending', async () => {
    const result = await sh(kernel, `node -e "setTimeout(() => console.log('later'), 50); console.log('now')"`)
    expect(result.stdout).toBe('now\nlater\n')
  })

  it('kills a process blocked in a read', async () => {
    const [stdinRead, stdinWrite] = kernel.pipe()
    const proc = kernel.spawn(['node', '-e', 'process.stdin.resume()'], { stdio: [stdinRead] })
    stdinRead.release()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(proc.state).toBe('running')
    kernel.kill(proc.pid)
    expect(await proc.exited).toBe(137)
    stdinWrite.release()
  })

  it('runs many processes concurrently', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => exec(kernel, ['echo', `job-${i}`])))
    expect(results.map((result) => result.stdout)).toEqual(Array.from({ length: 8 }, (_, i) => `job-${i}\n`))
  })

  it('emits spawn and exit events', async () => {
    const events: KernelEvent[] = []
    kernel.events.subscribe((event) => events.push(event))
    await sh(kernel, 'echo hi')
    expect(events.map((event) => event.type)).toEqual(['process.spawn', 'process.exit'])
    expect(events[1]).toMatchObject({ code: 0 })
  })
})

describe('modules and scripts', () => {
  it('loads CommonJS modules, JSON and node_modules packages', async () => {
    kernel.fs.mkdirp('/home/user/app/node_modules/greet')
    kernel.fs.writeFile('/home/user/app/node_modules/greet/package.json', '{"main": "lib/main.js"}')
    kernel.fs.mkdirp('/home/user/app/node_modules/greet/lib')
    kernel.fs.writeFile('/home/user/app/node_modules/greet/lib/main.js', "module.exports = (name) => 'hello ' + name")
    kernel.fs.writeFile('/home/user/app/config.json', '{"name": "webcore"}')
    kernel.fs.writeFile(
      '/home/user/app/index.js',
      "const greet = require('greet'); const { name } = require('./config'); console.log(greet(name), require('path').basename(__filename))",
    )
    expect((await sh(kernel, 'node app')).stdout).toBe('hello webcore index.js\n')
  })

  it('executes scripts with a #!/usr/bin/env node shebang', async () => {
    kernel.fs.writeFile('/home/user/hello', "#!/usr/bin/env node\nconsole.log('args:', process.argv.slice(2).join(','))\n", 0o755)
    expect((await sh(kernel, './hello a b')).stdout).toBe('args: a,b\n')
  })
})

describe('shell', () => {
  it('supports redirection, && / || and builtins', async () => {
    expect((await sh(kernel, 'echo saved > out.txt && cat < out.txt')).stdout).toBe('saved\n')
    expect((await sh(kernel, 'echo more >> out.txt; cat out.txt')).stdout).toBe('saved\nmore\n')
    expect((await sh(kernel, 'cd /tmp && pwd')).stdout).toBe('/tmp\n')
    expect((await sh(kernel, 'cat /nope || echo "status $?"')).stdout).toBe('status 1\n')
  })
})
