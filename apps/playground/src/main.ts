import {
  createShell,
  DEFAULT_ENV,
  installRootfs,
  installTarball,
  Kernel,
  PreviewBridge,
  previewPortOf,
  runLine,
  type KernelEvent,
} from '@webcore/kernel'
import { webProcessHost } from '@webcore/kernel/web'
import nodeLibUrl from '@webcore/node-lib/node-lib.bin?url'
import catUrl from '@webcore/wat-bin/cat.wasm?url'
import echoUrl from '@webcore/wat-bin/echo.wasm?url'
import lsUrl from '@webcore/wat-bin/ls.wasm?url'
import wcUrl from '@webcore/wat-bin/wc.wasm?url'
import './style.css'

const CREATE_VITE = 'https://registry.npmjs.org/create-vite/-/create-vite-9.2.1.tgz'

// The "HTTP server" example: a page plus a JSON endpoint it polls.
const SERVER_JS = `const http = require('node:http')

let visits = 0
const started = Date.now()

const page = () => \`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Hello from webcore</title>
    <style>
      body { font: 15px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; color: #1d2330 }
      code, pre { font: 13px ui-monospace, Menlo, monospace; background: #f2f4f8; border-radius: 6px }
      code { padding: 1px 5px } pre { padding: 12px 14px }
    </style>
  </head>
  <body>
    <h1>Hello from Node.js</h1>
    <p>This page comes from <code>http.createServer()</code> in Node \${process.version}, running in a
    Web Worker inside your browser tab. The request reached it over webcore's virtual TCP.</p>
    <p>Visits: \${visits}. Live stats from <code>/api/stats</code>:</p>
    <pre id="stats">loading…</pre>
    <script>
      const update = async () => {
        const stats = await (await fetch('/api/stats')).json()
        document.getElementById('stats').textContent = JSON.stringify(stats, null, 2)
      }
      update()
      setInterval(update, 1000)
    </script>
  </body>
</html>\`

http
  .createServer((req, res) => {
    if (req.url === '/api/stats') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ visits, uptime: Math.round((Date.now() - started) / 1000) + 's', pid: process.pid }))
    }
    visits++
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(page())
  })
  .listen(3000, () => console.log('Listening on http://localhost:3000 (Ctrl+C to stop)'))
`

interface Example {
  label: string
  command: string
  /** Host-side setup before the command runs. */
  prepare?: (kernel: Kernel) => Promise<void>
}

const EXAMPLES: Example[] = [
  { label: 'Real Node.js', command: `node -p "process.version + ' on ' + process.platform + ', ' + require('module').builtinModules.length + ' builtin modules'"` },
  {
    label: 'WASI → Node → WASI pipeline',
    command: `echo hello webcore | node -e "process.stdin.on('data', d => process.stdout.write(d.toString().toUpperCase()))" | wc`,
  },
  {
    label: 'Node spawns a WASI child',
    command: `node -e "const c = require('child_process').spawn('wc'); c.stdout.pipe(process.stdout); c.stdin.end('one two three\\n')"`,
  },
  { label: 'Read a file (WASI)', command: 'cat /etc/motd' },
  { label: 'List a directory (WASI)', command: 'ls /usr/bin' },
  {
    label: 'Node writes, WASI reads',
    command: `node -e "require('fs').writeFileSync('note.txt', 'written by node at ' + new Date().toISOString() + '\\n')" && cat note.txt`,
  },
  {
    label: 'A process spawns a process',
    command: `node -e "const r = require('child_process').spawnSync('echo', ['spawned', 'by', 'node']); console.log('child said:', r.stdout.toString().trim())"`,
  },
  { label: 'Exit codes', command: `node -e "process.exit(42)"; echo "exit status: $?"` },
  { label: 'Event loop + timers', command: `node -e "let n = 3; const t = setInterval(() => { console.log('tick', n); if (!--n) clearInterval(t) }, 300)"` },
  {
    label: 'Event loop phases',
    command: `node -e "setTimeout(() => console.log('timeout')); setImmediate(() => console.log('immediate')); process.nextTick(() => console.log('nextTick')); Promise.resolve().then(() => console.log('promise')); console.log('sync')"`,
  },
  { label: 'Uncaught error', command: `node -e "throw new Error('boom')"` },
  {
    label: 'HTTP server + preview',
    command: 'node server.js',
    prepare: async (kernel) => {
      kernel.fs.writeFile('/home/user/server.js', SERVER_JS)
    },
  },
  {
    label: 'ES modules',
    command: `node --input-type=module -e "import { basename } from 'node:path'; const { readFileSync } = await import('node:fs'); console.log(basename(import.meta.url), readFileSync('/etc/hostname', 'utf8').trim())"`,
  },
  {
    label: 'Scaffold a React app (create-vite)',
    command: 'node /opt/create-vite/index.js my-app --template react --no-interactive --no-immediate && ls my-app/src',
    // A preview of M1d: the real package, straight from the npm registry, unpacked into the VFS.
    prepare: async (kernel) => {
      try {
        kernel.fs.lookup('/opt/create-vite/index.js')
        return
      } catch {
        print(`fetching create-vite from the npm registry…\n`, 'meta')
      }
      const tarball = new Uint8Array(await (await fetch(CREATE_VITE)).arrayBuffer())
      const count = await installTarball(kernel, tarball, '/opt/create-vite')
      print(`unpacked ${count} files into /opt/create-vite\n`, 'meta')
    },
  },
]

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const output = $<HTMLDivElement>('output')
const input = $<HTMLInputElement>('input')
const ps1 = $<HTMLLabelElement>('ps1')
const status = $<HTMLDivElement>('status')
const eventsList = $<HTMLOListElement>('events')
const eventCount = $<HTMLSpanElement>('event-count')
const layout = document.querySelector<HTMLElement>('.layout')!
const preview = $<HTMLElement>('preview')
const portTabs = $<HTMLDivElement>('ports')
const addressPort = $<HTMLSpanElement>('address-port')
const addressPath = $<HTMLInputElement>('address-path')
const frame = $<HTMLIFrameElement>('frame')

const shell = createShell({ cwd: '/home/user', env: { ...DEFAULT_ENV, PWD: '/home/user' } })
const history: string[] = []
let historyIndex = 0
let running: AbortController | undefined
let eventTotal = 0

function print(text: string, className = 'out'): void {
  const last = output.lastElementChild
  if (last instanceof HTMLSpanElement && last.className === className) last.textContent += text
  else output.append(Object.assign(document.createElement('span'), { className, textContent: text }))
  output.scrollTop = output.scrollHeight
}

function renderPrompt(): void {
  const home = shell.env.HOME ?? ''
  const cwd = home && shell.cwd.startsWith(home) ? `~${shell.cwd.slice(home.length)}` : shell.cwd
  ps1.textContent = `user@webcore:${cwd}$`
}

function setStatus(text: string, state: 'booting' | 'ready' | 'busy' | 'error'): void {
  status.textContent = text
  status.dataset.state = state
}

function describeEvent(event: KernelEvent): string {
  switch (event.type) {
    case 'process.spawn':
      return `spawn  pid ${event.pid}  ${event.argv.join(' ').slice(0, 60)}`
    case 'process.exit':
      return `exit   pid ${event.pid}  → ${event.code}`
    case 'fs.change':
      return `fs     ${event.op} ${event.path}${event.to ? ` → ${event.to}` : ''}`
    case 'net.listen':
      return `net    pid ${event.pid}  listening on ${event.address}:${event.port}`
    case 'net.close':
      return `net    pid ${event.pid}  closed port ${event.port}`
  }
}

function logEvent(event: KernelEvent): void {
  eventTotal++
  eventCount.textContent = String(eventTotal)
  const item = document.createElement('li')
  item.dataset.type = event.type
  item.textContent = describeEvent(event)
  eventsList.prepend(item)
  while (eventsList.childElementCount > 200) eventsList.lastElementChild?.remove()
}

/**
 * The preview pane: one tab per listening port, showing the port through the PreviewBridge
 * (ADR-0014). Opens on the first port that starts listening.
 */
function setupPreview(kernel: Kernel): void {
  const bridge = new PreviewBridge(kernel)
  bridge.listen()
  const tabs = new Map<number, HTMLButtonElement>()
  let current: number | undefined

  const show = (port: number, path = '/') => {
    current = port
    preview.hidden = false
    layout.classList.add('has-preview')
    addressPort.textContent = `localhost:${port}`
    addressPath.value = path
    for (const [tabPort, tab] of tabs) tab.setAttribute('aria-selected', String(tabPort === port))
    frame.src = bridge.url(port, path)
  }

  kernel.events.subscribe((event) => {
    if (event.type === 'net.listen') {
      let tab = tabs.get(event.port)
      if (!tab) {
        tab = Object.assign(document.createElement('button'), { type: 'button', textContent: `:${event.port}` })
        tab.setAttribute('role', 'tab')
        tab.addEventListener('click', () => show(event.port))
        tabs.set(event.port, tab)
        portTabs.append(tab)
      }
      tab.dataset.state = 'open'
      const currentOpen = current !== undefined && tabs.get(current)?.dataset.state === 'open' && current !== event.port
      if (!currentOpen) show(event.port, current === event.port ? addressPath.value : '/')
    } else if (event.type === 'net.close') {
      const tab = tabs.get(event.port)
      if (tab) tab.dataset.state = 'closed'
    }
  })

  // The preview's client script reports navigations inside the frame.
  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'webcore:location' || event.source !== frame.contentWindow) return
    const port = previewPortOf(new URL(event.origin).hostname)
    if (port === undefined || port !== current || bridge.origin(port) !== event.origin) return
    const url = new URL(event.data.href)
    addressPath.value = url.pathname + url.search + url.hash
  })
  $<HTMLFormElement>('address').addEventListener('submit', (event) => {
    event.preventDefault()
    const path = addressPath.value.startsWith('/') ? addressPath.value : `/${addressPath.value}`
    if (current !== undefined) show(current, path)
  })
  $<HTMLButtonElement>('reload').addEventListener('click', () => {
    if (current !== undefined) show(current, addressPath.value || '/')
  })
}

async function run(kernel: Kernel, line: string, echo = true): Promise<number> {
  if (echo) print(`${ps1.textContent} ${line}\n`, 'cmd')
  if (line.trim() === 'clear') {
    output.replaceChildren()
    return 0
  }
  if (line.trim() === 'help') {
    print(`Commands: echo, cat, wc, ls (WASI) · node (JS) · cd, pwd, export, true, false (shell builtins)\n`)
    print(`Operators: |  >  >>  <  &&  ||  ;   Ctrl+C kills the running pipeline.\n`)
    return 0
  }
  const decoders = { out: new TextDecoder(), err: new TextDecoder() }
  running = new AbortController()
  input.disabled = true
  setStatus('running…', 'busy')
  const started = performance.now()
  const code = await runLine(kernel, shell, line, {
    signal: running.signal,
    onStdout: (chunk) => print(decoders.out.decode(chunk, { stream: true })),
    onStderr: (chunk) => print(decoders.err.decode(chunk, { stream: true }), 'err'),
  })
  const elapsed = performance.now() - started
  print(`[exit ${code} · ${elapsed.toFixed(0)} ms]\n`, 'meta')
  running = undefined
  input.disabled = false
  input.focus()
  renderPrompt()
  setStatus('ready · cross-origin isolated', 'ready')
  return code
}

async function boot(): Promise<void> {
  let kernel: Kernel
  try {
    kernel = new Kernel({ host: webProcessHost() })
  } catch (error) {
    setStatus('not cross-origin isolated', 'error')
    print(`${(error as Error).message}\n`, 'err')
    return
  }
  const download = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer())
  const urls = { cat: catUrl, echo: echoUrl, ls: lsUrl, wc: wcUrl }
  const [nodeLib, binaries] = await Promise.all([
    download(nodeLibUrl),
    Promise.all(Object.entries(urls).map(async ([name, url]) => [name, await download(url)])).then(Object.fromEntries),
  ])
  // Node's standard library, shared with every Node process (ADR-0012).
  kernel.addAsset('node-lib', nodeLib)
  installRootfs(kernel, binaries)
  kernel.events.subscribe(logEvent)
  setupPreview(kernel)

  const examples = $<HTMLDivElement>('examples')
  for (const example of EXAMPLES) {
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: example.label })
    button.title = example.command
    button.addEventListener('click', async () => {
      if (running) return
      await example.prepare?.(kernel)
      input.value = example.command
      void submit()
    })
    examples.append(button)
  }

  const submit = async () => {
    const line = input.value
    input.value = ''
    if (line.trim()) {
      history.push(line)
      historyIndex = history.length
    }
    await run(kernel, line)
  }

  $<HTMLFormElement>('prompt').addEventListener('submit', (event) => {
    event.preventDefault()
    if (!running) void submit()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'c' && event.ctrlKey && running) {
      event.preventDefault()
      print('^C\n', 'err')
      running.abort()
    }
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp' && historyIndex > 0) input.value = history[--historyIndex]
    else if (event.key === 'ArrowDown') input.value = history[++historyIndex] ?? ''
    else return
    event.preventDefault()
  })

  // Exposed for debugging from the console.
  Object.assign(globalThis, { webcore: { kernel, shell, run: (line: string) => run(kernel, line) } })

  renderPrompt()
  await run(kernel, 'cat /etc/motd', false)
}

void boot()
