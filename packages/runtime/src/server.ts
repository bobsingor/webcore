// The runtime's side of the SDK protocol (ADR-0017): calls from the embedding page, answered from
// the kernel. Nothing here touches the DOM, so tests drive it headless over a Node MessageChannel.
import {
  createShell,
  DEFAULT_ENV,
  Errno,
  errnoName,
  KernelError,
  runLine,
  type Kernel,
  type KernelEvent,
  type OpenFile,
  type Process,
  type PtyMaster,
  type Shell,
} from '@webcore/kernel'
import {
  PROTOCOL_VERSION,
  previewPortOf,
  type HostMessage,
  type Method,
  type Methods,
  type PortLike,
  type RemoteError,
  type RuntimeEvent,
  type RuntimeMessage,
  type SpawnRequestOptions,
  type TerminalRequestOptions,
} from '@webcore/sdk/protocol'

export interface ServeOptions {
  /** Preview origins, with `{port}` for the port (RuntimeInfo.previewOrigin). */
  previewOrigin: string
  /** Serves a preview page's channel, for the port it previews: the PreviewBridge. */
  previews?: { serve(channel: MessagePort, port: number): void }
}

interface Job {
  proc?: Process
  /** Writes to a spawned process's stdin, in order. */
  stdin?: OpenFile
  writing: Promise<unknown>
  /** A shell line: aborting interrupts it. */
  abort?: AbortController
  /** A terminal's master end: keystrokes go in, the screen comes out. */
  terminal?: PtyMaster
}

const HOME = DEFAULT_ENV.HOME

/** Serves the SDK on `port`, and tells it the runtime is ready. */
export function serveRuntime(kernel: Kernel, port: PortLike, options: ServeOptions): void {
  const send = (message: RuntimeMessage) => port.postMessage(message)
  const jobs = new Map<number, Job>()
  const sessions = new Map<number, Shell>()
  let nextSession = 1

  // Kernel events, batched: one message per burst (an npm install writes thousands of files).
  let unsubscribe: (() => void) | undefined
  let pending: RuntimeEvent[] = []
  const forward = (event: KernelEvent) => {
    const runtimeEvent: RuntimeEvent = event
    if (!pending.length) queueMicrotask(flushEvents)
    pending.push(runtimeEvent)
  }
  const flushEvents = () => {
    if (!pending.length) return
    send({ t: 'events', events: pending })
    pending = []
  }

  const output = (job: number, fd: 1 | 2) => (data: Uint8Array) => send({ t: 'output', job, fd, data })

  const methods: { [M in Method]: (...args: Methods[M][0]) => Methods[M][1] | Promise<Methods[M][1]> } = {
    'fs.readFile': (path) => kernel.fs.readFile(absolute(path)),
    'fs.writeFile': (path, data) => kernel.writeFile(absolute(path), data),
    'fs.mkdir': (path, recursive) => kernel.mkdir(absolute(path), { recursive }),
    'fs.readdir': (path) => {
      const node = kernel.fs.lookup(absolute(path))
      if (node.kind !== 'dir') throw new KernelError(Errno.ENOTDIR, path)
      return kernel.fs.readdir(node).map(({ name, type }) => ({ name, type }))
    },
    'fs.stat': (path) => {
      const { type, size, mode, mtimeMs } = kernel.fs.stat(kernel.fs.lookup(absolute(path)))
      return { type, size, mode, mtimeMs }
    },
    'fs.rm': (path, recursive, force) => kernel.remove(absolute(path), { recursive, force }),
    'fs.rename': (from, to) => kernel.rename(absolute(from), absolute(to)),

    spawn: (job, argv, request) => spawn(job, argv, request),
    'terminal.open': (job, argv, request) => openTerminal(job, argv, request),

    'shell.create': (init) => {
      const cwd = init.cwd ?? HOME
      const shell = createShell({ cwd, env: { ...DEFAULT_ENV, PWD: cwd, ...init.env } })
      const session = nextSession++
      sessions.set(session, shell)
      return { session, cwd: shell.cwd, env: { ...shell.env } }
    },
    'shell.run': async (job, session, line) => {
      const shell = sessions.get(session)
      if (!shell) throw new Error(`No shell session ${session}`)
      const abort = new AbortController()
      jobs.set(job, { abort, writing: Promise.resolve() })
      try {
        const code = await runLine(kernel, shell, line, { signal: abort.signal, onStdout: output(job, 1), onStderr: output(job, 2) })
        return { code, cwd: shell.cwd, env: { ...shell.env } }
      } finally {
        jobs.delete(job)
      }
    },

    events: (enabled) => {
      if (enabled) unsubscribe ??= kernel.events.subscribe(forward)
      else {
        unsubscribe?.()
        unsubscribe = undefined
      }
    },
  }

  function spawn(job: number, argv: string[], request: SpawnRequestOptions): { pid: number } {
    const cwd = request.cwd ?? HOME
    const env = { ...DEFAULT_ENV, PWD: cwd, ...request.env }
    const [stdinRead, stdinWrite] = kernel.pipe()
    const [stdoutRead, stdoutWrite] = kernel.pipe()
    const [stderrRead, stderrWrite] = kernel.pipe()
    let proc: Process
    try {
      proc = kernel.spawn(argv, { cwd, env, stdio: [stdinRead, stdoutWrite, stderrWrite] })
    } catch (error) {
      for (const file of [stdinWrite, stdoutRead, stderrRead]) file.release()
      throw error
    } finally {
      // The process holds its own references; dropping ours lets EOF reach the readers.
      for (const file of [stdinRead, stdoutWrite, stderrWrite]) file.release()
    }
    const state: Job = { proc, stdin: stdinWrite, writing: Promise.resolve() }
    jobs.set(job, state)
    void Promise.all([drain(stdoutRead, output(job, 1)), drain(stderrRead, output(job, 2)), proc.exited]).then(([, , code]) => {
      closeStdin(state)
      jobs.delete(job)
      send({ t: 'exit', job, code })
    })
    return { pid: proc.pid }
  }

  function openTerminal(job: number, argv: string[], request: TerminalRequestOptions): { pid: number } {
    const cwd = request.cwd ?? HOME
    const env = { ...DEFAULT_ENV, PWD: cwd, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...request.env }
    const { master, slave } = kernel.openpty({ cols: request.cols, rows: request.rows })
    let proc: Process
    try {
      // The program leads a new session, with this terminal as its controlling terminal.
      proc = kernel.spawn(argv, { cwd, env, stdio: [slave, slave, slave], terminal: slave })
    } catch (error) {
      master.release()
      throw error
    } finally {
      slave.release()
    }
    const state: Job = { proc, terminal: master, writing: Promise.resolve() }
    jobs.set(job, state)
    const reading = drain(master, output(job, 1), false)
    void proc.exited.then(async (code) => {
      // Show what it printed last, then close the terminal: what's left of the session hangs up.
      await Promise.race([reading, new Promise((resolve) => setTimeout(resolve, 50))])
      closeTerminal(state)
      await reading
      jobs.delete(job)
      send({ t: 'exit', job, code })
    })
    return { pid: proc.pid }
  }

  function closeTerminal(state: Job): void {
    const terminal = state.terminal
    if (!terminal) return
    state.terminal = undefined
    terminal.release()
  }

  function closeStdin(state: Job): void {
    const stdin = state.stdin
    if (!stdin) return
    state.stdin = undefined
    state.writing = state.writing.then(() => stdin.release())
  }

  async function call(id: number, method: Method, args: unknown[]): Promise<void> {
    try {
      const handler = methods[method] as ((...args: unknown[]) => unknown) | undefined
      if (!handler) throw new Error(`Unknown method ${method}`)
      send({ t: 'result', id, value: await handler(...args) })
    } catch (error) {
      send({ t: 'error', id, error: toRemoteError(error) })
    }
  }

  port.addEventListener('message', (event) => {
    const message = event.data as HostMessage
    switch (message?.t) {
      case 'call':
        void call(message.id, message.method, message.args)
        break
      case 'stdin': {
        const state = jobs.get(message.job)
        if (state?.terminal) {
          if (message.data === null) closeTerminal(state)
          else state.terminal.write(message.data)
          break
        }
        const stdin = state?.stdin
        if (!state || !stdin) break
        if (message.data === null) closeStdin(state)
        else {
          const data = message.data
          state.writing = state.writing.then(() => stdin.write(data)).catch(() => {})
        }
        break
      }
      case 'resize':
        jobs.get(message.job)?.terminal?.pty.resize({ cols: message.cols | 0, rows: message.rows | 0 })
        break
      case 'signal': {
        const state = jobs.get(message.job)
        if (state?.abort) state.abort.abort()
        else if (state?.proc) {
          if (message.group) kernel.killGroup(state.proc.pgid, message.signal)
          else kernel.kill(state.proc.pid, message.signal)
        }
        break
      }
      case 'preview': {
        const channel = event.ports[0]
        // The SDK relays these from preview pages; check the origin again here.
        const previewed = previewPortOf(options.previewOrigin, message.origin)
        if (channel && previewed !== undefined) options.previews?.serve(channel, previewed)
        break
      }
    }
  })
  port.start()
  send({ t: 'ready', info: { protocol: PROTOCOL_VERSION, previewOrigin: options.previewOrigin } })
}

function absolute(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new KernelError(Errno.EINVAL, `paths must be absolute: ${path}`)
  return path
}

function toRemoteError(error: unknown): RemoteError {
  if (error instanceof KernelError) return { message: error.message, code: errnoName(error.errno) }
  return { message: error instanceof Error ? error.message : String(error) }
}

async function drain(file: OpenFile, onChunk: (chunk: Uint8Array) => void, release = true): Promise<void> {
  try {
    for (;;) {
      const chunk = await file.read(64 * 1024)
      if (!chunk.length) break
      onChunk(chunk)
    }
  } finally {
    if (release) file.release()
  }
}
