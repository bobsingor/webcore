import { connect, type Runtime, type RuntimeEvent, type RuntimeTerminal } from '@webcore/sdk'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import './style.css'

// The runtime runs on its own origin (ADR-0009, ADR-0017): @webcore/runtime's dev server, unless
// VITE_WEBCORE_RUNTIME points elsewhere.
const RUNTIME_URL = import.meta.env.VITE_WEBCORE_RUNTIME ?? `${location.protocol}//webcore.localhost:5190/`

// /home is saved in a workspace (M2b): ?workspace=<name> picks one, ?from=<snapshot> starts it there.
const params = new URLSearchParams(location.search)
const WORKSPACE = params.get('workspace') || 'playground'
const FROM = params.get('from') ?? undefined
let lastSnapshot: string | undefined

async function takeSnapshot(runtime: Runtime): Promise<string> {
  lastSnapshot = await runtime.snapshot()
  return `Snapshot of /home: ${lastSnapshot.slice(0, 12)}…`
}

async function restoreSnapshot(runtime: Runtime): Promise<string> {
  if (!lastSnapshot) return 'Take a snapshot first.'
  await runtime.restore(lastSnapshot)
  return `Restored /home to ${lastSnapshot.slice(0, 12)}…`
}

/** A fork is a new workspace that starts from a snapshot of this one; here, in another tab. */
async function forkInNewTab(runtime: Runtime): Promise<string> {
  const snapshot = await runtime.snapshot()
  const url = new URL(location.href)
  url.searchParams.set('workspace', `fork-${Math.random().toString(36).slice(2, 8)}`)
  url.searchParams.set('from', snapshot)
  window.open(url, '_blank')
  return `Forked ${WORKSPACE} at ${snapshot.slice(0, 12)}… into a new tab.`
}

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
  /** Setup before the command runs. */
  prepare?: (runtime: Runtime) => Promise<void>
  /** Instead of a command: an action that also works while a command runs. */
  action?: (runtime: Runtime) => Promise<string>
}

const APP_JSX = '/home/user/my-app/src/App.jsx'

/** What an editor does: rewrites a file through the runtime, which tells its watchers. */
async function editApp(runtime: Runtime): Promise<string> {
  let source: string
  try {
    source = await runtime.fs.readFile(APP_JSX, 'utf8')
  } catch {
    return `${APP_JSX} doesn't exist yet: run "npm create vite (React)" first.\n`
  }
  const heading = `Edited at ${new Date().toLocaleTimeString()}`
  await runtime.fs.writeFile(APP_JSX, source.replace(/<h1>[^<]*<\/h1>/, `<h1>${heading}</h1>`))
  return `Wrote "${heading}" into ${APP_JSX}. With "npm run dev" running, the preview updates in place (HMR).\n`
}

const EXAMPLES: Example[] = [
  { label: 'Real Node.js', command: `node -p "process.version + ' on ' + process.platform + ', ' + require('module').builtinModules.length + ' builtin modules'"` },
  {
    label: 'BusyBox → Node → BusyBox pipeline',
    command: `echo hello webcore | node -e "process.stdin.on('data', d => process.stdout.write(d.toString().toUpperCase()))" | wc`,
  },
  {
    label: 'Node spawns a C program',
    command: `node -e "const c = require('child_process').spawn('wc'); c.stdout.pipe(process.stdout); c.stdin.end('one two three\\n')"`,
  },
  { label: 'grep, sed and awk', command: `ls -l /bin | grep -c busybox; seq 5 | awk '{ s += $1 } END { print "sum", s }' | sed 's/sum/total:/'` },
  { label: 'Job control (Ctrl+Z, fg)', command: `sleep 30 & jobs; kill %1; wait; echo "Ctrl+Z stops the foreground job; fg and bg continue it"` },
  {
    label: 'Node writes, BusyBox reads',
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
    prepare: (runtime) => runtime.fs.writeFile('/home/user/server.js', SERVER_JS),
  },
  {
    label: 'ES modules',
    command: `node --input-type=module -e "import { basename } from 'node:path'; const { readFileSync } = await import('node:fs'); console.log(basename(import.meta.url), readFileSync('/etc/hostname', 'utf8').trim())"`,
  },
  {
    label: 'npm create vite (React)',
    command: 'cd /home/user && npm create vite@latest my-app -- --template react --no-interactive',
  },
  {
    label: 'npm install',
    command: 'cd /home/user/my-app && npm install',
  },
  {
    label: 'npm run dev (Vite)',
    command: 'cd /home/user/my-app && npm run dev',
  },
  {
    label: 'Edit App.jsx (HMR)',
    command: '',
    action: editApp,
  },
  { label: 'Snapshot /home', command: '', action: takeSnapshot },
  { label: 'Restore snapshot', command: '', action: restoreSnapshot },
  { label: 'Fork in a new tab', command: '', action: forkInNewTab },
  {
    label: 'worker_threads',
    command: `node -e "const { Worker } = require('worker_threads'); const body = () => { const t = require('worker_threads'); t.parentPort.postMessage('hello from thread ' + t.threadId) }; new Worker('(' + body + ')()', { eval: true }).on('message', console.log)"`,
  },
]

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const status = $<HTMLDivElement>('status')
const eventsList = $<HTMLOListElement>('events')
const eventCount = $<HTMLSpanElement>('event-count')
const layout = document.querySelector<HTMLElement>('.layout')!
const preview = $<HTMLElement>('preview')
const portTabs = $<HTMLDivElement>('ports')
const addressPort = $<HTMLSpanElement>('address-port')
const addressPath = $<HTMLInputElement>('address-path')
const frame = $<HTMLIFrameElement>('frame')

let eventTotal = 0

function setStatus(text: string, state: 'booting' | 'ready' | 'busy' | 'error'): void {
  status.textContent = text
  status.dataset.state = state
}

function describeEvent(event: RuntimeEvent): string {
  switch (event.type) {
    case 'process.spawn':
      return `spawn  pid ${event.pid}  ${event.argv.join(' ').slice(0, 60)}`
    case 'process.exec':
      return `exec   pid ${event.pid}  ${event.argv.join(' ').slice(0, 60)}`
    case 'process.exit':
      return `exit   pid ${event.pid}  → ${event.code}`
    case 'fs.change':
      return `fs     ${event.op} ${event.path}${event.to ? ` → ${event.to}` : ''}`
    case 'net.listen':
      return `net    pid ${event.pid}  listening on ${event.address}:${event.port}`
    case 'net.close':
      return `net    pid ${event.pid}  closed port ${event.port}`
    case 'fs.snapshot':
      return `snap   ${event.path} → ${event.hash.slice(0, 12)}`
    case 'fs.restore':
      return `restore ${event.path} ← ${event.hash.slice(0, 12)}`
    case 'workspace.save':
      return `saved  workspace ${event.name} → ${event.head.slice(0, 12)}`
  }
}

function logEvent(event: RuntimeEvent): void {
  eventTotal++
  eventCount.textContent = String(eventTotal)
  const item = document.createElement('li')
  item.dataset.type = event.type
  item.textContent = describeEvent(event)
  eventsList.prepend(item)
  while (eventsList.childElementCount > 200) eventsList.lastElementChild?.remove()
}

/**
 * The preview pane: one tab per listening port, showing the port through the runtime's preview
 * bridge (ADR-0014). Opens on the first port that starts listening.
 */
function setupPreview(runtime: Runtime): void {
  const tabs = new Map<number, HTMLButtonElement>()
  let current: number | undefined

  const show = (port: number, path = '/') => {
    current = port
    preview.hidden = false
    layout.classList.add('has-preview')
    addressPort.textContent = `localhost:${port}`
    addressPath.value = path
    for (const [tabPort, tab] of tabs) tab.setAttribute('aria-selected', String(tabPort === port))
    frame.src = runtime.previewUrl(port, path)
  }

  runtime.events.subscribe((event) => {
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
    const port = runtime.previewPortOf(event.origin)
    if (port === undefined || port !== current) return
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

let READY = `ready · runtime on ${new URL(RUNTIME_URL).host}`

/**
 * The terminal: xterm.js on a pseudo-terminal in the runtime (M2a), running a login shell. When
 * the shell exits, a new one starts.
 */
function setupTerminal(runtime: Runtime): { type(text: string): void; current(): RuntimeTerminal | undefined } {
  const term = new Terminal({
    fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#131821', foreground: '#d7dde8', cursor: '#7cc4ff', selectionBackground: '#2a3446' },
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  const container = $<HTMLDivElement>('term')
  term.open(container)
  fit.fit()
  new ResizeObserver(() => fit.fit()).observe(container)

  let session: RuntimeTerminal | undefined
  const encoder = new TextEncoder()
  term.onData((data) => session?.write(encoder.encode(data)))
  term.onResize(({ cols, rows }) => session?.resize(cols, rows))
  void (async () => {
    for (;;) {
      session = await runtime.openTerminal({ cols: term.cols, rows: term.rows, onData: (chunk) => term.write(chunk) })
      const code = await session.exited
      term.write(`\r\n\x1b[2m[sh exited with status ${code}; starting a new shell]\x1b[0m\r\n`)
    }
  })()
  term.focus()
  return {
    // As if typed: ^E ^U clear whatever is on the line first.
    type: (text) => {
      session?.write(encoder.encode(`\x05\x15${text}\r`))
      term.focus()
    },
    current: () => session,
  }
}

async function boot(): Promise<void> {
  setStatus('starting runtime…', 'booting')
  let runtime: Runtime
  try {
    runtime = await connect({ url: RUNTIME_URL, workspace: WORKSPACE, from: FROM })
    // A forked tab keeps its own workspace from here on; reloading shouldn't fork again.
    if (FROM) history.replaceState(null, '', `?workspace=${encodeURIComponent(WORKSPACE)}`)
  } catch (error) {
    setStatus('runtime unavailable', 'error')
    $<HTMLDivElement>('term').textContent = `Could not start the webcore runtime at ${RUNTIME_URL}: ${(error as Error).message}`
    return
  }
  runtime.events.subscribe(logEvent)
  setupPreview(runtime)
  const terminal = setupTerminal(runtime)
  const workspace = runtime.info.workspace
  READY = !workspace
    ? `ready · in memory only`
    : workspace.writable
      ? `ready · workspace ${workspace.name}`
      : `ready · workspace ${workspace.name} (open in another tab: not saving)`
  setStatus(READY, 'ready')
  runtime.events.subscribe((event) => {
    if (event.type !== 'workspace.save') return
    setStatus(`${READY} · saved ${new Date(event.time).toLocaleTimeString()}`, 'ready')
  })

  const examples = $<HTMLDivElement>('examples')
  let notice: ReturnType<typeof setTimeout> | undefined
  for (const example of EXAMPLES) {
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: example.label })
    button.title = example.command || example.label
    button.addEventListener('click', async () => {
      if (example.action) {
        setStatus((await example.action(runtime)).trim(), 'ready')
        clearTimeout(notice)
        notice = setTimeout(() => setStatus(READY, 'ready'), 5000)
        return
      }
      await example.prepare?.(runtime)
      terminal.type(example.command)
    })
    examples.append(button)
  }

  // Exposed for debugging from the console.
  Object.assign(globalThis, { webcore: { runtime, terminal: terminal.current } })
}

void boot()
