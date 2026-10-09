// The SDK (@webcore/sdk) and the runtime's server (@webcore/runtime) over a MessageChannel: what
// an embedding page can do with a runtime (ADR-0017). In a browser the channel crosses origins.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serveRuntime } from '../../runtime/src/server.ts'
import { openRuntime, RuntimeError, type Runtime } from '../../sdk/src/client.ts'
import type { RuntimeEvent } from '../../sdk/src/protocol.ts'
import { PreviewBridge, type Kernel, type PreviewReply } from '../src/index.ts'
import { boot } from './helpers.ts'

const PREVIEW_ORIGIN = 'http://p{port}.localhost:5190'

let kernel: Kernel
let runtime: Runtime

beforeEach(async () => {
  kernel = boot()
  const { port1, port2 } = new MessageChannel()
  const previews = new PreviewBridge(kernel, { origin: (port) => PREVIEW_ORIGIN.replace('{port}', String(port)) })
  serveRuntime(kernel, port1, { previewOrigin: PREVIEW_ORIGIN, previews })
  runtime = await openRuntime(port2)
})

afterEach(() => {
  runtime.close()
  kernel.shutdown()
})

describe('runtime files', () => {
  it('reads, writes, lists, renames and removes', async () => {
    const { fs } = runtime
    await fs.mkdir('/home/user/a/b', { recursive: true })
    await fs.writeFile('/home/user/a/b/note.txt', 'hello')
    expect(await fs.readFile('/home/user/a/b/note.txt', 'utf8')).toBe('hello')
    expect(await fs.readFile('/home/user/a/b/note.txt')).toEqual(new TextEncoder().encode('hello'))
    expect(await fs.readdir('/home/user/a')).toEqual([{ name: 'b', type: 'dir' }])
    expect(await fs.stat('/home/user/a/b/note.txt')).toMatchObject({ type: 'file', size: 5 })
    await fs.rename('/home/user/a/b/note.txt', '/home/user/a/moved.txt')
    expect((await fs.readdir('/home/user/a')).map((entry) => entry.name)).toEqual(['b', 'moved.txt'])
    await fs.rm('/home/user/a', { recursive: true })
    await expect(fs.stat('/home/user/a')).rejects.toMatchObject({ name: 'RuntimeError', code: 'ENOENT' })
    await fs.rm('/home/user/a', { force: true })
    await expect(fs.readFile('relative.txt')).rejects.toMatchObject({ code: 'EINVAL' })
  })

  it('reports file changes like a process would, so watchers see them', async () => {
    const events: RuntimeEvent[] = []
    const unsubscribe = runtime.events.subscribe((event) => events.push(event))
    await runtime.fs.writeFile('/home/user/x.txt', '1')
    await runtime.fs.writeFile('/home/user/x.txt', '2')
    await runtime.fs.mkdir('/home/user/d')
    await new Promise((resolve) => setTimeout(resolve, 10))
    unsubscribe()
    expect(events.map((event) => event.type === 'fs.change' && `${event.op} ${event.path}`)).toEqual([
      'create /home/user/x.txt',
      'write /home/user/x.txt',
      'mkdir /home/user/d',
    ])
  })
})

describe('runtime processes', () => {
  it('runs commands and collects their output', async () => {
    expect(await runtime.exec(['node', '-p', '6 * 7'])).toEqual({ code: 0, stdout: '42\n', stderr: '' })
    expect(await runtime.exec(['wc'], { stdin: 'four' })).toMatchObject({ code: 0, stdout: '      0       1       4\n' })
    await expect(runtime.exec(['no-such-command'])).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('streams stdin and stdout, and kills on request', async () => {
    let out = ''
    const cat = await runtime.spawn(['cat'], { onStdout: (chunk) => (out += new TextDecoder().decode(chunk)) })
    expect(cat.pid).toBeGreaterThan(0)
    cat.write('one ')
    cat.write('two')
    cat.end()
    expect(await cat.exited).toBe(0)
    expect(out).toBe('one two')

    const sleeper = await runtime.spawn(['node', '-e', 'setInterval(() => {}, 1000)'])
    sleeper.kill()
    expect(await sleeper.exited).toBe(143)

    const abort = new AbortController()
    const job = await runtime.spawn(['node', '-e', 'setInterval(() => {}, 1000)'], { signal: abort.signal })
    abort.abort()
    expect(await job.exited).toBe(130)
  })

  it('keeps a shell session’s directory and variables between lines', async () => {
    const session = await runtime.createShell()
    expect(session.cwd).toBe('/home/user')
    let out = ''
    const onStdout = (chunk: Uint8Array) => (out += new TextDecoder().decode(chunk))
    expect(await session.run('mkdir -p /tmp/w && cd /tmp/w && export GREETING=hi', { onStdout })).toBe(0)
    expect(session.cwd).toBe('/tmp/w')
    expect(session.env.GREETING).toBe('hi')
    expect(await session.run('pwd && echo $GREETING | wc', { onStdout })).toBe(0)
    expect(out).toBe('/tmp/w\n      1       1       3\n')
    expect(await session.run('node -e "process.exit(3)"')).toBe(3)
  })
})

describe('runtime snapshots', () => {
  it('snapshots and restores /home', async () => {
    await runtime.fs.writeFile('/home/user/notes.txt', 'first')
    const snapshot = await runtime.snapshot()
    expect(snapshot).toMatch(/^[0-9a-f]{64}$/)
    await runtime.fs.writeFile('/home/user/notes.txt', 'second')
    await runtime.fs.writeFile('/home/user/extra.txt', 'extra')
    await runtime.restore(snapshot)
    expect(await runtime.fs.readFile('/home/user/notes.txt', 'utf8')).toBe('first')
    await expect(runtime.fs.stat('/home/user/extra.txt')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(runtime.restore('0'.repeat(64))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(runtime.info.workspace).toBeNull()
  })
})

describe('runtime terminals', () => {
  it('runs programs on a terminal, with keystrokes, resizes and hang-up', async () => {
    let screen = ''
    const decoder = new TextDecoder()
    const onData = (chunk: Uint8Array) => (screen += decoder.decode(chunk, { stream: true }))
    const tty = await runtime.openTerminal({ command: ['node', '-p', "process.stdout.isTTY + ' ' + process.stdout.columns + ' ' + process.env.TERM"], cols: 90, onData })
    expect(await tty.exited).toBe(0)
    expect(screen).toBe('true 90 xterm-256color\r\n')

    screen = ''
    const shell = await runtime.openTerminal({ onData })
    const waitFor = async (pattern: RegExp) => {
      for (let i = 0; i < 800 && !pattern.test(screen); i++) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(screen).toMatch(pattern)
    }
    // The prompt, then readline's cursor positioning.
    await waitFor(/\$ (\x1b\[\d+G)?$/)
    shell.resize(120, 40)
    shell.write('node -p process.stdout.columns\r')
    // On a TTY, node -p prints with colors, as real Node does.
    await waitFor(/\x1b\[33m120\x1b\[39m\r\n/)
    // Closing the terminal hangs up: the shell dies of SIGHUP.
    shell.close()
    expect(await shell.exited).toBe(129)
  })
})

describe('runtime previews', () => {
  it('builds preview URLs and recognizes only its own preview origins', () => {
    expect(runtime.previewUrl(3000, '/a b')).toBe('http://p3000.localhost:5190/__webcore/boot.html?path=%2Fa%20b')
    expect(runtime.previewPortOf('http://p3000.localhost:5190')).toBe(3000)
    expect(runtime.previewPortOf('http://p3000.localhost:5180')).toBeUndefined()
    expect(runtime.previewPortOf('https://p3000.evil.example')).toBeUndefined()
    expect(runtime.connectPreview('https://evil.example', new MessageChannel().port1)).toBe(false)
  })

  it('serves a preview channel that the SDK relays from a preview page', async () => {
    const listening = new Promise<number>((resolve) => {
      const unsubscribe = runtime.events.subscribe((event) => {
        if (event.type !== 'net.listen') return
        unsubscribe()
        resolve(event.port)
      })
    })
    await runtime.fs.writeFile('/home/user/server.js', "require('http').createServer((req, res) => res.end('hi from ' + req.url)).listen(3000)")
    const server = await runtime.spawn(['node', 'server.js'])
    const port = await listening

    // What a preview page's Service Worker sends over the channel it got through the SDK.
    const { port1, port2 } = new MessageChannel()
    expect(runtime.connectPreview(`http://p${port}.localhost:5190`, port2)).toBe(true)
    const replies: PreviewReply[] = []
    const done = new Promise<void>((resolve) => {
      port1.addEventListener('message', (event) => {
        replies.push(event.data)
        if (event.data.type === 'end' || (event.data.type === 'error' && event.data.id === 2)) resolve()
      })
    })
    port1.start()
    // A channel is bound to the port its page previews, as browsers keep origins apart.
    port1.postMessage({ type: 'fetch', id: 1, port: 5173, method: 'GET', url: '/', host: 'p5173.localhost:5190', headers: [], navigate: false })
    port1.postMessage({ type: 'fetch', id: 2, port, method: 'GET', url: '/page', host: `p${port}.localhost:5190`, headers: [], navigate: false })
    await done
    port1.close()
    server.kill()
    expect(replies[0]).toEqual({ type: 'error', id: 1, message: "This preview can't fetch from port 5173" })
    expect(replies[1]).toMatchObject({ type: 'head', id: 2, status: 200 })
    const body = replies.filter((reply) => reply.type === 'chunk').map((reply) => new TextDecoder().decode((reply as { data: Uint8Array }).data))
    expect(body.join('')).toBe('hi from /page')
  })
})

describe('runtime connection', () => {
  it('rejects pending and later calls once closed', async () => {
    const pending = runtime.exec(['node', '-e', 'setTimeout(() => {}, 5000)'])
    await new Promise((resolve) => setTimeout(resolve, 20))
    runtime.close()
    await expect(pending).resolves.toMatchObject({ code: 137 })
    await expect(runtime.fs.readFile('/etc/motd')).rejects.toBeInstanceOf(RuntimeError)
  })
})
