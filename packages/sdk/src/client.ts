// A connected runtime, as the embedding page sees it: typed async calls over the runtime's
// MessagePort (ADR-0017). Nothing here touches the DOM, so it also runs headless over a Node
// MessageChannel.
import {
  PREVIEW_BOOT_PATH,
  previewOrigin,
  previewPortOf,
  type DirEntry,
  type FileStat,
  type HostMessage,
  type Method,
  type Methods,
  type PortLike,
  type RemoteError,
  type RuntimeEvent,
  type RuntimeInfo,
  type RuntimeMessage,
  type ShellState,
} from './protocol.ts'

/** An error from the runtime. Filesystem and process errors carry an errno name in `code`. */
export class RuntimeError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'RuntimeError'
    this.code = code
  }
}

export interface OutputHandlers {
  onStdout?(chunk: Uint8Array): void
  onStderr?(chunk: Uint8Array): void
}

export interface SpawnOptions extends OutputHandlers {
  /** Default: /home/user. */
  cwd?: string
  /** Added to the default environment (PATH, HOME, USER, LANG, TMPDIR, PWD). */
  env?: Record<string, string>
  /** Aborting sends SIGINT to the process and everything it started, like Ctrl+C. */
  signal?: AbortSignal
}

export interface ExecOptions extends SpawnOptions {
  /** Written to stdin, which is then closed. */
  stdin?: string | Uint8Array
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface RuntimeProcess {
  readonly pid: number
  /** The exit status: 128 + the signal number when killed. */
  readonly exited: Promise<number>
  write(data: string | Uint8Array): void
  /** Closes stdin. */
  end(): void
  /** Signals the process (SIGTERM by default). */
  kill(signal?: number): void
}

export interface TerminalOptions {
  /** Default: a login shell, ['sh', '-l']. */
  command?: string[]
  cols?: number
  rows?: number
  cwd?: string
  /** Added to the default environment, which sets TERM=xterm-256color and COLORTERM=truecolor. */
  env?: Record<string, string>
  /** What the terminal shows: bytes for a terminal emulator such as xterm.js. */
  onData(chunk: Uint8Array): void
}

/** A program on a pseudo-terminal (M2a), such as a shell, for a terminal emulator to drive. */
export interface RuntimeTerminal {
  readonly pid: number
  /** The program's exit status. */
  readonly exited: Promise<number>
  /** Keystrokes: what the user types, including control characters (^C is "\x03"). */
  write(data: string | Uint8Array): void
  /** The terminal's new size; the foreground job gets SIGWINCH. */
  resize(cols: number, rows: number): void
  /** Hangs up, as closing a terminal window does: the session gets SIGHUP. */
  close(): void
}

export interface ShellSession {
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  /** Runs a command line (pipes, redirections, &&, cd, export). Resolves with its exit status. */
  run(line: string, options?: OutputHandlers & { signal?: AbortSignal }): Promise<number>
}

/** Paths are absolute. */
export interface RuntimeFs {
  readFile(path: string): Promise<Uint8Array>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string | Uint8Array): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  readdir(path: string): Promise<DirEntry[]>
  stat(path: string): Promise<FileStat>
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  rename(from: string, to: string): Promise<void>
}

export interface RuntimeEvents {
  /** Kernel events (ADR-0010), from now on. Returns a function that unsubscribes. */
  subscribe(listener: (event: RuntimeEvent) => void): () => void
}

/** Starts a runtime in `workspace` from snapshot `from` (connect() provides it). */
type Forker = (from: string, workspace: string) => Promise<Runtime>

interface Job {
  onOutput(fd: 1 | 2, data: Uint8Array): void
  onExit?(code: number): void
}

const encoder = new TextEncoder()
const SIGINT = 2
const SIGKILL = 9
const SIGTERM = 15

export class Runtime {
  readonly info: RuntimeInfo
  readonly fs: RuntimeFs
  readonly events: RuntimeEvents
  #port: PortLike
  #onClose: () => void
  #nextId = 1
  #nextJob = 1
  #calls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  #jobs = new Map<number, Job>()
  #listeners = new Set<(event: RuntimeEvent) => void>()
  #closed = false
  #fork?: Forker

  /** Use connect() in a page, or openRuntime() with a port. */
  constructor(port: PortLike, info: RuntimeInfo, onClose: () => void = () => {}, fork?: Forker) {
    this.#fork = fork
    this.#port = port
    this.info = info
    this.#onClose = onClose
    port.addEventListener('message', (event) => this.#receive(event.data as RuntimeMessage))

    const decoder = new TextDecoder()
    this.fs = {
      readFile: ((path: string, encoding?: 'utf8') =>
        this.#call('fs.readFile', [path]).then((bytes) => (encoding ? decoder.decode(bytes) : bytes))) as RuntimeFs['readFile'],
      writeFile: (path, data) => this.#call('fs.writeFile', [path, data]),
      mkdir: (path, options = {}) => this.#call('fs.mkdir', [path, options.recursive ?? false]),
      readdir: (path) => this.#call('fs.readdir', [path]),
      stat: (path) => this.#call('fs.stat', [path]),
      rm: (path, options = {}) => this.#call('fs.rm', [path, options.recursive ?? false, options.force ?? false]),
      rename: (from, to) => this.#call('fs.rename', [from, to]),
    }
    this.events = {
      subscribe: (listener) => {
        this.#listeners.add(listener)
        if (this.#listeners.size === 1) this.#call('events', [true]).catch(() => {})
        return () => {
          if (!this.#listeners.delete(listener) || this.#listeners.size || this.#closed) return
          this.#call('events', [false]).catch(() => {})
        }
      },
    }
  }

  /** Starts a process. Its stdin stays open until end(). */
  async spawn(argv: string[], options: SpawnOptions = {}): Promise<RuntimeProcess> {
    const job = this.#nextJob++
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>((resolve) => (resolveExit = resolve))
    this.#jobs.set(job, {
      onOutput: (fd, data) => (fd === 1 ? options.onStdout : options.onStderr)?.(data),
      onExit: (code) => {
        this.#jobs.delete(job)
        resolveExit(code)
      },
    })
    let pid: number
    try {
      ;({ pid } = await this.#call('spawn', [job, argv, { cwd: options.cwd, env: options.env }]))
    } catch (error) {
      this.#jobs.delete(job)
      throw error
    }
    const signal = (number: number, group: boolean) => this.#post({ t: 'signal', job, signal: number, group })
    if (options.signal?.aborted) signal(SIGINT, true)
    else options.signal?.addEventListener('abort', () => signal(SIGINT, true), { once: true })
    return {
      pid,
      exited,
      write: (data) => this.#post({ t: 'stdin', job, data: typeof data === 'string' ? encoder.encode(data) : data }),
      end: () => this.#post({ t: 'stdin', job, data: null }),
      kill: (number = SIGTERM) => signal(number, false),
    }
  }

  /** Runs a process to completion and collects its output. */
  async exec(argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const decoders = { out: new TextDecoder(), err: new TextDecoder() }
    let stdout = ''
    let stderr = ''
    const proc = await this.spawn(argv, {
      ...options,
      onStdout: (chunk) => {
        stdout += decoders.out.decode(chunk, { stream: true })
        options.onStdout?.(chunk)
      },
      onStderr: (chunk) => {
        stderr += decoders.err.decode(chunk, { stream: true })
        options.onStderr?.(chunk)
      },
    })
    if (options.stdin !== undefined) proc.write(options.stdin)
    proc.end()
    const code = await proc.exited
    return { code, stdout: stdout + decoders.out.decode(), stderr: stderr + decoders.err.decode() }
  }

  /** Starts a program, a login shell by default, on a new terminal. */
  async openTerminal(options: TerminalOptions): Promise<RuntimeTerminal> {
    const job = this.#nextJob++
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>((resolve) => (resolveExit = resolve))
    this.#jobs.set(job, {
      onOutput: (_fd, data) => options.onData(data),
      onExit: (code) => {
        this.#jobs.delete(job)
        resolveExit(code)
      },
    })
    let pid: number
    try {
      ;({ pid } = await this.#call('terminal.open', [
        job,
        options.command ?? ['sh', '-l'],
        { cols: options.cols ?? 80, rows: options.rows ?? 24, cwd: options.cwd, env: options.env },
      ]))
    } catch (error) {
      this.#jobs.delete(job)
      throw error
    }
    return {
      pid,
      exited,
      write: (data) => this.#post({ t: 'stdin', job, data: typeof data === 'string' ? encoder.encode(data) : data }),
      resize: (cols, rows) => this.#post({ t: 'resize', job, cols, rows }),
      close: () => this.#post({ t: 'stdin', job, data: null }),
    }
  }

  /** A shell session: its working directory and exported variables carry over between lines. */
  async createShell(init: Partial<ShellState> = {}): Promise<ShellSession> {
    const { session, cwd, env } = await this.#call('shell.create', [init])
    const state: ShellState = { cwd, env }
    return {
      get cwd() {
        return state.cwd
      },
      get env() {
        return state.env
      },
      run: async (line, options = {}) => {
        const job = this.#nextJob++
        this.#jobs.set(job, { onOutput: (fd, data) => (fd === 1 ? options.onStdout : options.onStderr)?.(data) })
        const interrupt = () => this.#post({ t: 'signal', job, signal: SIGINT, group: true })
        options.signal?.addEventListener('abort', interrupt, { once: true })
        try {
          const result = await this.#call('shell.run', [job, session, line])
          state.cwd = result.cwd
          state.env = result.env
          return result.code
        } finally {
          this.#jobs.delete(job)
          options.signal?.removeEventListener('abort', interrupt)
        }
      },
    }
  }

  /**
   * Snapshots /home (ADR-0007) and returns its hash. Unchanged files aren't hashed again, and
   * identical contents are stored once. In a persistent workspace the snapshot is saved, and kept.
   */
  snapshot(): Promise<string> {
    return this.#call('snapshot', [])
  }

  /** Replaces /home with a snapshot. Watchers (dev servers) see the files that differ change. */
  restore(snapshot: string): Promise<void> {
    return this.#call('restore', [snapshot])
  }

  /**
   * Starts a second runtime from a snapshot of this one's /home, in a workspace of its own: try
   * something there, and keep or drop it. Needs a runtime from connect().
   */
  async fork(workspace = `fork-${Math.random().toString(36).slice(2, 10)}`): Promise<Runtime> {
    if (!this.#fork) throw new RuntimeError('fork() needs a runtime started with connect()')
    return this.#fork(await this.snapshot(), workspace)
  }

  /** The URL to load in an iframe to preview `path` on `port` (ADR-0014). */
  previewUrl(port: number, path = '/'): string {
    return `${previewOrigin(this.info.previewOrigin, port)}${PREVIEW_BOOT_PATH}?path=${encodeURIComponent(path)}`
  }

  /** The port `origin` previews, or undefined if it isn't one of this runtime's preview origins. */
  previewPortOf(origin: string): number | undefined {
    return previewPortOf(this.info.previewOrigin, origin)
  }

  /**
   * Hands the runtime a preview page's channel to its bridge. connect() does this for preview
   * frames in its window; call it for previews elsewhere (another window, a nested frame).
   */
  connectPreview(origin: string, channel: MessagePort): boolean {
    if (this.#closed || this.previewPortOf(origin) === undefined) return false
    this.#port.postMessage({ t: 'preview', origin } satisfies HostMessage, [channel])
    return true
  }

  /** Disconnects, and removes the runtime frame: every process ends. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#port.close()
    for (const { reject } of this.#calls.values()) reject(new RuntimeError('The runtime was closed'))
    this.#calls.clear()
    for (const job of [...this.#jobs.values()]) job.onExit?.(128 + SIGKILL)
    this.#jobs.clear()
    this.#listeners.clear()
    this.#onClose()
  }

  #post(message: HostMessage): void {
    if (!this.#closed) this.#port.postMessage(message)
  }

  #call<M extends Method>(method: M, args: Methods[M][0]): Promise<Methods[M][1]> {
    if (this.#closed) return Promise.reject(new RuntimeError('The runtime was closed'))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#calls.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.#post({ t: 'call', id, method, args } as HostMessage)
    })
  }

  #receive(message: RuntimeMessage): void {
    switch (message?.t) {
      case 'result':
      case 'error': {
        const call = this.#calls.get(message.id)
        if (!call) return
        this.#calls.delete(message.id)
        if (message.t === 'result') call.resolve(message.value)
        else call.reject(toError(message.error))
        return
      }
      case 'events':
        for (const event of message.events) {
          for (const listener of this.#listeners) {
            try {
              listener(event)
            } catch (error) {
              console.error('[webcore] event listener failed', error)
            }
          }
        }
        return
      case 'output':
        this.#jobs.get(message.job)?.onOutput(message.fd, message.data)
        return
      case 'exit':
        this.#jobs.get(message.job)?.onExit?.(message.code)
        return
    }
  }
}

function toError(error: RemoteError): RuntimeError {
  return new RuntimeError(error.message, error.code)
}

/** Waits for the runtime on `port` to report that it booted. */
export function openRuntime(
  port: PortLike,
  options: { timeout?: number; onClose?: () => void; fork?: Forker } = {},
): Promise<Runtime> {
  const timeout = options.timeout ?? 30_000
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data as RuntimeMessage
      if (message?.t === 'ready') {
        cleanup()
        resolve(new Runtime(port, message.info, options.onClose, options.fork))
      } else if (message?.t === 'failed') {
        cleanup()
        reject(new RuntimeError(message.message))
      }
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new RuntimeError(`The runtime didn't start within ${timeout} ms`))
    }, timeout)
    function cleanup() {
      clearTimeout(timer)
      port.removeEventListener('message', onMessage)
    }
    port.addEventListener('message', onMessage)
    port.start()
  })
}
