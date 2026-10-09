import { Errno, KernelError, kerr } from '../abi/errno.ts'
import {
  AT_FDCWD,
  DEFAULT_PATH,
  O_ACCMODE,
  O_CLOEXEC,
  O_CREAT,
  O_DIRECTORY,
  O_EXCL,
  O_RDONLY,
  O_RDWR,
  O_TRUNC,
  POLLHUP,
  POLLIN,
  POLLNVAL,
  POLLOUT,
} from '../abi/constants.ts'
import { clearBell, completeSync, createPage, DEFAULT_PAGE_BYTES, ringBell } from '../abi/page.ts'
import {
  defaultStops,
  defaultTerminates,
  FIONREAD,
  isValidSignal,
  SIGCHLD,
  SIGCONT,
  SIGHUP,
  SIGKILL,
  SIGSTOP,
  TCGETS,
  TCSETS,
  TCSETSF,
  TCSETSW,
  TIOCGPGRP,
  TIOCGSID,
  TIOCGWINSZ,
  TIOCSCTTY,
  TIOCSPGRP,
  TIOCSWINSZ,
  waitStatus,
  WCONTINUED,
  WNOHANG,
  WUNTRACED,
  type SignalAction,
  type SignalMessage,
  type Termios,
  type WinSize,
} from '../abi/signals.ts'
import type { BootMessage, SyscallReply, SyscallRequest } from '../abi/protocol.ts'
import { SPAWN_SYNC_HEADER_BYTES } from '../abi/syscalls.ts'
import type { SocketInfo, SpawnSyncRequest, SyscallArgs, SyscallName, SyscallReturn, SyscallValue } from '../abi/syscalls.ts'
import { EventBus } from './events.ts'
import { extractArchive, type ExtractOptions } from './extract.ts'
import { Watcher } from './watch.ts'
import { Listener, Network, Socket } from './net.ts'
import { resolveExecutable, resolveFile, type Executable } from './exec.ts'
import { DeviceHandle, DirHandle, FileHandle, PipeReader, PipeWriter, type OpenFile } from './files.ts'
import { dirname, normalize, resolve } from './path.ts'
import { Pipe } from './pipe.ts'
import { Pty, PtyMaster, PtySlave, ptyOf } from './pty.ts'
import { diffTrees, materialize, snapshotTree } from './snapshot.ts'
import { MemoryStore } from './store.ts'
import { MAX_FDS, Process, type Channel, type Thread, type WorkerLike } from './process.ts'
import { MemFS, type FileNode, type VNode } from './vfs.ts'
import { memoryImport, type MemoryImport } from './wasm.ts'

/** Environment-specific process startup (ADR-0011). */
export interface ProcessHost {
  /** Starts a Worker running the environment's process entry (`src/process/worker*.ts`). */
  createWorker(onError: (error: unknown) => void): WorkerLike
}

export interface KernelOptions {
  host: ProcessHost
  /** Payload bytes in each process's syscall page. Bounds a single read. */
  pageBytes?: number
  /** Read-only assets shared with every process (see addAsset). */
  assets?: Record<string, Uint8Array>
  /** Where snapshots keep their objects (ADR-0007). By default, memory. */
  store?: MemoryStore
}

export interface SpawnOptions {
  cwd?: string
  env?: Record<string, string>
  /**
   * Files for fds 0, 1, 2 and on. The kernel takes its own references; gaps among 0 to 2 get
   * /dev/null, and others stay closed.
   */
  stdio?: readonly (OpenFile | undefined)[]
  ppid?: number
  /** Process group to join. By default a process leads a new group of its own. */
  pgid?: number
  /** Session to join. By default a process leads a new session of its own. */
  sid?: number
  /** The file creation mask. Default: 022. */
  umask?: number
  /**
   * A terminal (a PTY slave) that becomes the controlling terminal of the process's new session,
   * with the process's group in the foreground: what a terminal emulator does for its shell.
   */
  terminal?: OpenFile
}

type Handler<N extends SyscallName> = (
  proc: Process,
  ...args: SyscallArgs<N>
) => SyscallReturn<N> | Promise<SyscallReturn<N>>
type Handlers = { [N in SyscallName]: Handler<N> }
type AnyHandler = (proc: Process, ...args: unknown[]) => SyscallValue | Promise<SyscallValue>

const STDIO_ALIASES = new Map([
  ['/dev/stdin', 0],
  ['/dev/stdout', 1],
  ['/dev/stderr', 2],
])
/** Syscalls that a signal interrupts with EINTR even under SA_RESTART, as on Linux. */
const NEVER_RESTARTED = new Set<string>(['poll', 'pause'])
const DEFAULT_UMASK = 0o022
const encoder = new TextEncoder()

export class Kernel {
  readonly fs = new MemFS()
  readonly events = new EventBus()
  /** Virtual TCP: listening ports and connections (ADR-0014). */
  readonly net = new Network(this.events)
  /** Snapshot objects: blobs and trees by hash (ADR-0007). */
  readonly store: MemoryStore
  private readonly host: ProcessHost
  private readonly pageBytes: number
  private readonly procs = new Map<number, Process>()
  private readonly modules = new WeakMap<FileNode, { version: number; module: Promise<WebAssembly.Module>; memory?: MemoryImport }>()
  private readonly assets: Record<string, Uint8Array> = {}
  private readonly watchers = new Set<Watcher>()
  private readonly ptys = new Set<Pty>()
  /** wait4 callers, by parent pid, woken when one of their children changes state. */
  private readonly childWaiters = new Map<number, (() => void)[]>()
  private nextPid = 1
  private nextPty = 0

  constructor(options: KernelOptions) {
    this.store = options.store ?? new MemoryStore()
    this.host = options.host
    this.pageBytes = options.pageBytes ?? DEFAULT_PAGE_BYTES
    for (const [name, bytes] of Object.entries(options.assets ?? {})) this.addAsset(name, bytes)
    this.events.subscribe((event) => {
      if (event.type !== 'fs.change' || !this.watchers.size) return
      for (const watcher of this.watchers) {
        watcher.notify(event.op, event.path)
        if (event.to) watcher.notify(event.op, event.to)
      }
    })
  }

  /**
   * Registers read-only data shared with every process, such as the Node standard library. It is
   * copied once into shared memory, so passing it to each new Worker costs nothing.
   */
  addAsset(name: string, bytes: Uint8Array): void {
    const shared = new Uint8Array(new SharedArrayBuffer(bytes.byteLength))
    shared.set(bytes)
    this.assets[name] = shared
  }

  hasAsset(name: string): boolean {
    return Object.hasOwn(this.assets, name)
  }

  // ---------------------------------------------------------------------------------------------
  // Host API

  /**
   * Starts a process. Throws synchronously when the command can't be resolved (ENOENT, ENOEXEC);
   * later failures (e.g. an invalid Wasm module) are reported on the process's stderr.
   */
  spawn(argv: string[], options: SpawnOptions = {}): Process {
    if (!argv.length) throw kerr('EINVAL', 'empty argv')
    const env = { ...options.env }
    const cwd = normalize(options.cwd ?? '/')
    if (this.fs.lookup(cwd).kind !== 'dir') throw kerr('ENOTDIR', cwd)
    const exe = resolveExecutable(this.fs, argv, cwd, env.PATH ?? DEFAULT_PATH)
    const pid = this.nextPid++
    const proc = new Process({ pid, ppid: options.ppid ?? 0, pgid: options.pgid, sid: options.sid, argv: exe.argv, env, cwd })
    if (options.umask !== undefined) proc.umask = options.umask
    const terminal = options.terminal && ptyOf(options.terminal)
    if (terminal && proc.sid === pid && !this.sessionAlive(terminal.session)) {
      terminal.session = proc.sid
      terminal.foreground = proc.pgid
    }
    for (let fd = 0; fd < Math.max(3, options.stdio?.length ?? 0); fd++) {
      proc.fds[fd] = options.stdio?.[fd]?.retain() ?? (fd < 3 ? new DeviceHandle('null', O_RDWR) : undefined)
    }
    this.procs.set(proc.pid, proc)
    this.events.emit({ type: 'process.spawn', pid: proc.pid, ppid: proc.ppid, argv: proc.argv, cwd })
    void this.boot(proc, exe)
    return proc
  }

  /**
   * Creates a pseudo-terminal (M2a). The caller owns one reference to each end: the master is the
   * terminal emulator's, the slave becomes a program's stdin, stdout and stderr.
   */
  openpty(size: WinSize = { rows: 24, cols: 80 }): { master: PtyMaster; slave: PtySlave } {
    const pty = new Pty(this.nextPty++, size, {
      signalGroup: (pgid, signal) => this.killGroup(pgid, signal),
      hangup: (closed) => {
        // The terminal went away: its session's leader and foreground job hang up.
        const session = closed.session
        if (session === undefined) return
        if (closed.foreground !== undefined) this.killGroup(closed.foreground, SIGHUP)
        const leader = this.procs.get(session)
        if (leader?.alive) this.deliver(leader, SIGHUP)
      },
    })
    this.ptys.add(pty)
    return { master: new PtyMaster(pty), slave: new PtySlave(pty) }
  }

  /** Creates a pipe. The caller owns one reference to each end. */
  pipe(): [PipeReader, PipeWriter] {
    const pipe = new Pipe()
    return [new PipeReader(pipe), new PipeWriter(pipe)]
  }

  /** Opens a file outside any process (e.g. for shell redirection). The caller owns the reference. */
  open(path: string, flags: number, mode = 0o666): OpenFile {
    return this.openPath(normalize(path), flags, mode)
  }

  /**
   * Opens a TCP connection to a process listening on `port`, as a client outside any process (the
   * preview bridge). The caller owns the returned socket and must release() it.
   */
  connect(port: number, address = '127.0.0.1'): Socket {
    return this.net.connect(address, port)
  }

  /**
   * Unpacks a (gzipped) tar archive, such as an npm package, into `dir` (ADR-0015). Returns the
   * number of files written.
   */
  async extract(archive: Uint8Array, dir: string, options: ExtractOptions = {}): Promise<number> {
    const target = normalize(dir)
    const files = await extractArchive(this.fs, archive, target, options)
    this.events.emit({ type: 'fs.change', op: 'create', path: target })
    return files
  }

  /**
   * Writes a file from outside any process (an editor), reporting the change like a process write
   * would, so watchers (fs.watch, Vite's HMR) see it.
   */
  writeFile(path: string, content: Uint8Array | string): void {
    const target = normalize(path)
    const existed = this.fs.tryLookup(target) !== undefined
    this.fs.writeFile(target, content)
    this.events.emit({ type: 'fs.change', op: existed ? 'write' : 'create', path: target })
  }

  /** Creates a directory from outside any process; `recursive` creates missing parents too. */
  mkdir(path: string, options: { recursive?: boolean } = {}): void {
    const target = normalize(path)
    if (!options.recursive) {
      this.fs.mkdir(target)
      this.events.emit({ type: 'fs.change', op: 'mkdir', path: target })
      return
    }
    let prefix = ''
    for (const segment of target.split('/').filter(Boolean)) {
      prefix += `/${segment}`
      const node = this.fs.tryLookup(prefix)
      if (node?.kind === 'dir') continue
      if (node) throw kerr('ENOTDIR', prefix)
      this.fs.mkdir(prefix)
      this.events.emit({ type: 'fs.change', op: 'mkdir', path: prefix })
    }
  }

  /** Removes a file, link or directory from outside any process, like `rm` (`-r`, `-f`). */
  remove(path: string, options: { recursive?: boolean; force?: boolean } = {}): void {
    const target = normalize(path)
    const node = this.fs.tryLookup(target, false)
    if (!node) {
      if (options.force) return
      throw kerr('ENOENT', target)
    }
    if (node.kind !== 'dir') {
      this.fs.unlink(target)
      this.events.emit({ type: 'fs.change', op: 'unlink', path: target })
      return
    }
    if (options.recursive) {
      for (const entry of this.fs.readdir(node)) this.remove(`${target === '/' ? '' : target}/${entry.name}`, options)
    }
    this.fs.rmdir(target)
    this.events.emit({ type: 'fs.change', op: 'rmdir', path: target })
  }

  /**
   * Snapshots the directory at `path` (ADR-0007): returns its tree hash. Only what changed since
   * the last snapshot is hashed, and the objects stay in `store`.
   */
  async snapshot(path = '/home'): Promise<string> {
    const target = normalize(path)
    const node = this.fs.lookup(target)
    if (node.kind !== 'dir') throw kerr('ENOTDIR', target)
    const hash = await snapshotTree(this.store, node)
    this.events.emit({ type: 'fs.snapshot', path: target, hash })
    return hash
  }

  /**
   * Replaces the directory at `path` with snapshot `hash`, whose objects must be in `store`. The
   * new tree shares the stored data until files are written (copy-on-write). Watchers get an
   * fs.change event for each difference, so dev servers see restored files.
   */
  async restore(hash: string, path = '/home'): Promise<void> {
    const target = normalize(path)
    const current = this.fs.tryLookup(target, false)
    if (current && current.kind !== 'dir') throw kerr('ENOTDIR', target)
    const before = current ? await snapshotTree(this.store, current) : undefined
    const tree = materialize(this.fs, this.store, hash, current?.mode ?? 0o755)
    this.fs.replace(target, tree)
    this.events.emit({ type: 'fs.restore', path: target, hash })
    diffTrees(this.store, before, hash, target, (op, changed) => this.events.emit({ type: 'fs.change', op, path: changed }))
  }

  /** Renames from outside any process. */
  rename(from: string, to: string): void {
    const source = normalize(from)
    const target = normalize(to)
    this.fs.rename(source, target)
    this.events.emit({ type: 'fs.change', op: 'rename', path: source, to: target })
  }

  getProcess(pid: number): Process | undefined {
    return this.procs.get(pid)
  }

  /** Live and zombie processes. */
  get processes(): Process[] {
    return [...this.procs.values()]
  }

  /**
   * Sends `signal` (SIGKILL by default). The process's disposition decides: its default action
   * (most signals terminate with status 128 + signal), nothing, or its handler.
   */
  kill(pid: number, signal = SIGKILL): void {
    const proc = this.procs.get(pid)
    if (proc) this.deliver(proc, signal)
  }

  /** Signals every live process in a group, as a terminal does for Ctrl+C. */
  killGroup(pgid: number, signal = SIGKILL): void {
    for (const proc of [...this.procs.values()]) {
      if (proc.pgid === pgid && proc.alive) this.deliver(proc, signal)
    }
  }

  shutdown(): void {
    for (const proc of [...this.procs.values()]) this.terminate(proc, 137, 9)
  }

  // ---------------------------------------------------------------------------------------------
  // Process lifecycle

  private async boot(proc: Process, exe: Executable): Promise<void> {
    try {
      const compiled = exe.personality === 'wasi' ? this.compile(exe.node) : undefined
      const module = await compiled?.module
      if (proc.state === 'exited') return
      const { channel, port } = this.openChannel(proc)
      proc.channel = channel
      proc.page = channel.page
      proc.port = channel.port
      proc.execPath = exe.path
      proc.personality = exe.personality
      proc.worker = this.host.createWorker((error) => this.crash(proc, error))
      const boot: BootMessage = {
        pid: proc.pid,
        ppid: proc.ppid,
        argv: proc.argv,
        env: proc.env,
        cwd: proc.cwd,
        execPath: exe.path,
        personality: exe.personality,
        module,
        memory: compiled?.memory,
        ignored: [...proc.dispositions].filter(([, action]) => action === 'ignore').map(([signal]) => signal),
        assets: this.assets,
        page: channel.page,
        port,
      }
      proc.worker.postMessage(boot, [port])
      proc.state = 'running'
    } catch (error) {
      this.crash(proc, error)
    }
  }

  /** A syscall channel: a page for sync calls and a port for everything else (ADR-0002). */
  private openChannel(proc: Process, thread?: Thread): { channel: Channel; port: MessagePort } {
    const { port1, port2 } = new MessageChannel()
    const channel: Channel = { page: createPage(this.pageBytes), port: port1, owner: proc, thread, acting: [] }
    port1.addEventListener('message', (event) => void this.dispatch(proc, event.data, channel))
    port1.start()
    return { channel, port: port2 }
  }

  /** Starts a worker_threads thread: a new Worker in an existing process. */
  private spawnThread(proc: Process, env: Record<string, string>, options: Record<string, unknown>, threadPort: MessagePort, id?: number): number {
    let resolve!: (code: number) => void
    const thread: Thread = {
      id: id ?? proc.nextThreadId++,
      alive: true,
      exited: new Promise((done) => (resolve = done)),
      resolve: (code) => resolve(code),
    }
    const { channel, port } = this.openChannel(proc, thread)
    thread.channel = channel
    proc.threads.set(thread.id, thread)
    thread.worker = this.host.createWorker((error) => {
      console.error(`[kernel] thread ${thread.id} of pid ${proc.pid} failed`, error)
      this.endThread(proc, thread, 1)
    })
    const boot: BootMessage = {
      pid: proc.pid,
      ppid: proc.ppid,
      argv: proc.argv,
      env,
      cwd: proc.cwd,
      execPath: proc.execPath,
      personality: 'node',
      assets: this.assets,
      page: channel.page,
      port,
      thread: { id: thread.id, port: threadPort, options },
    }
    thread.worker.postMessage(boot, [port, threadPort])
    return thread.id
  }

  private endThread(proc: Process, thread: Thread, code: number): void {
    if (!thread.alive) return
    thread.alive = false
    thread.channel?.port.close()
    try {
      thread.worker?.terminate()
    } catch {
      // Already gone.
    }
    // Unlike a process's, a thread's exit code is a full integer (Node reports it as is).
    thread.resolve(code)
  }

  private compile(node: FileNode): { module: Promise<WebAssembly.Module>; memory?: MemoryImport } {
    const cached = this.modules.get(node)
    if (cached?.version === node.version) return cached
    const bytes = node.data.slice(0, node.size)
    const compiled = { version: node.version, module: WebAssembly.compile(bytes), memory: memoryImport(bytes) }
    this.modules.set(node, compiled)
    return compiled
  }

  /** The process died outside its own control (bad module, Worker error). */
  /** Terminal requests (M2a), with Linux's rules for sessions and foreground groups. */
  private ioctl(proc: Process, file: OpenFile, request: number, arg: unknown): unknown {
    const pty = ptyOf(file)
    if (!pty) throw kerr('ENOTTY')
    switch (request) {
      case TCGETS:
        return { ...pty.termios, cc: [...pty.termios.cc] }
      case TCSETS:
      case TCSETSW:
      case TCSETSF:
        pty.setTermios(arg as Termios, request === TCSETSF)
        return 0
      case TIOCGWINSZ:
        return { ...pty.winsize }
      case TIOCSWINSZ:
        pty.resize(arg as WinSize)
        return 0
      case FIONREAD:
        return pty.available
      case TIOCSCTTY:
        // A session leader without a terminal makes this one its controlling terminal.
        if (proc.sid !== proc.pid) throw kerr('EPERM')
        if (pty.session !== proc.sid && this.sessionAlive(pty.session)) throw kerr('EPERM')
        pty.session = proc.sid
        pty.foreground = proc.pgid
        return 0
      case TIOCGPGRP:
        if (pty.session !== proc.sid) throw kerr('ENOTTY')
        return pty.foreground ?? 0
      case TIOCSPGRP: {
        if (pty.session !== proc.sid) throw kerr('ENOTTY')
        const pgid = Number(arg)
        if (!this.processes.some((member) => member.pgid === pgid && member.sid === proc.sid && member.alive)) throw kerr('EPERM')
        pty.foreground = pgid
        return 0
      }
      case TIOCGSID:
        if (pty.session === undefined) throw kerr('ENOTTY')
        return pty.session
      default:
        throw kerr('EINVAL')
    }
  }

  private crash(proc: Process, error: unknown): void {
    if (proc.state === 'exited') return
    const message = error instanceof Error ? error.message : String(error)
    try {
      const pending = proc.fds[2]?.write(encoder.encode(`${proc.argv[0]}: ${message}\n`))
      if (pending instanceof Promise) pending.catch(() => {})
    } catch {
      // stderr is gone; nothing left to report to.
    }
    this.terminate(proc, 1)
  }

  /**
   * Signal delivery: the default action (terminate, stop, or nothing), nothing, or the process's
   * handler. A Node process gets a message on its port; a WASI process takes its signals between
   * syscalls (the doorbell), and one blocked in a syscall is interrupted (EINTR). SIGCONT always
   * continues a stopped process.
   */
  private deliver(proc: Process, signal: number): void {
    if (!proc.alive || !isValidSignal(signal)) return
    if (signal === SIGKILL) return this.terminate(proc, 128 + SIGKILL, SIGKILL)
    if (signal === SIGCONT && proc.stopped) {
      proc.resume()
      this.notifyParent(proc)
    }
    if (signal === SIGSTOP) return this.stop(proc, signal)
    const action = proc.dispositions.get(signal)
    if (action === 'ignore') return
    if (action === 'handle') {
      if (proc.personality !== 'wasi') {
        proc.port?.postMessage({ t: 'sig', signal } satisfies SignalMessage)
        return
      }
      if (!proc.pending.includes(signal)) proc.pending.push(signal)
      // A vfork parent waits for its child; it takes the signal once it runs again.
      if (this.running(proc)) {
        this.ring(proc)
        proc.interrupt(proc.restart.has(signal))
      }
      return
    }
    if (defaultStops(signal)) this.stop(proc, signal)
    else if (defaultTerminates(signal)) this.terminate(proc, 128 + signal, signal)
  }

  /** Job control: the process's syscalls wait until SIGCONT. A WASI process checks in at once. */
  private stop(proc: Process, signal: number): void {
    if (proc.stopped) return
    proc.stop(signal)
    this.ring(proc)
    this.notifyParent(proc)
  }

  /** Whether the process runs its own code: not a vfork parent waiting for its child. */
  private running(proc: Process): boolean {
    const channel = proc.channel
    return !channel || (channel.acting.at(-1) ?? channel.owner) === proc
  }

  /** Tells a running WASI process to take its signals (or wait, while stopped). */
  private ring(proc: Process): void {
    if (proc.personality === 'wasi' && proc.channel && this.running(proc)) ringBell(proc.channel.page)
  }

  /** A child exited, stopped or continued: its parent's wait4 looks again, and gets SIGCHLD. */
  private notifyParent(child: Process): void {
    const parent = this.procs.get(child.ppid)
    if (!parent?.alive) return
    for (const wake of this.childWaiters.get(parent.pid)?.splice(0) ?? []) wake()
    this.deliver(parent, SIGCHLD)
  }

  /**
   * Linux's rule for orphaned process groups: when `exited` leaves one of its children's groups
   * without a parent in another group of the session, and the group has a stopped member, the
   * group gets SIGHUP and then SIGCONT. A shell that exits doesn't leave its stopped jobs behind.
   */
  private hangUpOrphanedGroups(exited: Process): void {
    const groups = new Set(this.processes.filter((child) => child.ppid === exited.pid && child.alive && child.pgid !== exited.pgid).map((child) => child.pgid))
    for (const pgid of groups) {
      const members = this.processes.filter((member) => member.pgid === pgid && member.alive)
      const anchored = members.some((member) => {
        const parent = this.procs.get(member.ppid)
        return parent?.alive && parent.pgid !== pgid && parent.sid === member.sid
      })
      if (anchored || !members.some((member) => member.stopped)) continue
      this.killGroup(pgid, SIGHUP)
      this.killGroup(pgid, SIGCONT)
    }
  }

  /** Waits until a child of `parent` changes state; a signal interrupts it (EINTR). */
  private childChange(parent: Process): Promise<void> {
    const signal = parent.signal
    if (signal.aborted) return Promise.reject(kerr('EINTR'))
    return new Promise((resolve, reject) => {
      const waiters = this.childWaiters.get(parent.pid) ?? []
      this.childWaiters.set(parent.pid, waiters)
      const onAbort = () => {
        const index = waiters.indexOf(wake)
        if (index >= 0) waiters.splice(index, 1)
        reject(kerr('EINTR'))
      }
      const wake = () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      waiters.push(wake)
    })
  }

  /**
   * execve: `proc` runs `exe` from now on. A vfork child gets a Worker of its own, and the thread
   * that ran it continues as its parent; a process replacing itself gets a new Worker.
   */
  private exec(proc: Process, exe: Executable, env: Record<string, string>): void {
    proc.argv = exe.argv
    proc.env = env
    proc.closeOnExec()
    for (const [signal, action] of [...proc.dispositions]) if (action === 'handle') proc.dispositions.delete(signal)
    proc.restart.clear()
    proc.pending.length = 0
    const channel = proc.channel
    proc.channel = undefined
    if (channel && channel.owner !== proc) {
      channel.acting.pop()
      this.resumeVforkParent(channel)
    } else {
      // The program's threads end with it, as on Linux.
      for (const thread of [...proc.threads.values()]) this.endThread(proc, thread, 0)
      proc.port?.close()
      try {
        proc.worker?.terminate()
      } catch {
        // Already gone.
      }
      proc.worker = undefined
    }
    this.events.emit({ type: 'process.exec', pid: proc.pid, argv: proc.argv })
    void this.boot(proc, exe)
  }

  /** The thread that ran a vfork child runs its parent again, which may have signals waiting. */
  private resumeVforkParent(channel: Channel): void {
    const parent = channel.acting.at(-1) ?? channel.owner
    if (parent.pending.length) this.ring(parent)
  }

  /** Readiness of `fds` for poll: [revents, bytes readable] for each. */
  private pollFds(proc: Process, fds: [number, number][]): [number, number][] {
    return fds.map(([fd, events]) => {
      const file = Number.isInteger(fd) && fd >= 0 ? proc.fds[fd] : undefined
      if (!file) return [POLLNVAL, 0]
      const ready = file.readiness()
      let revents = ready.hangup ? POLLHUP : 0
      if (ready.read && events & POLLIN) revents |= POLLIN
      if (ready.write && events & POLLOUT) revents |= POLLOUT
      return [revents, ready.bytes]
    })
  }

  /** Waits until one of `files` may have become ready, `deadline` passes, or a signal comes. */
  private readinessChange(files: OpenFile[], deadline: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(kerr('EINTR'))
    return new Promise((resolve, reject) => {
      const stops: (() => void)[] = []
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = (error?: unknown) => {
        for (const stop of stops) stop()
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      }
      const onAbort = () => done(kerr('EINTR'))
      for (const file of files) stops.push(file.watchReadiness(() => done()))
      if (Number.isFinite(deadline)) timer = setTimeout(() => done(), Math.max(0, deadline - Date.now()))
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Whether any live process belongs to session `sid`. */
  private sessionAlive(sid: number | undefined): boolean {
    return sid !== undefined && this.processes.some((proc) => proc.sid === sid && proc.alive)
  }

  private terminate(proc: Process, code: number, signal: number | null = null): void {
    if (proc.state === 'exited') return
    proc.termSignal = signal
    proc.markExited(code & 0xff)
    // vfork children running on this process's Worker die with it.
    if (proc.channel?.owner === proc) {
      for (const child of proc.channel.acting.splice(0).reverse()) this.terminate(child, 128 + SIGKILL, SIGKILL)
    }
    this.childWaiters.delete(proc.pid)
    proc.closeAll()
    proc.port?.close()
    try {
      proc.worker?.terminate()
    } catch {
      // Already gone.
    }
    for (const thread of [...proc.threads.values()]) this.endThread(proc, thread, code)
    this.events.emit({ type: 'process.exit', pid: proc.pid, code: proc.exitCode! })
    this.notifyParent(proc)
    this.hangUpOrphanedGroups(proc)

    // A session leader's exit takes its controlling terminal away; the foreground job hangs up.
    for (const pty of [...this.ptys]) {
      if (!pty.open) this.ptys.delete(pty)
      else if (pty.session === proc.sid && proc.sid === proc.pid) {
        const foreground = pty.foreground
        pty.session = undefined
        pty.foreground = undefined
        if (foreground !== undefined && foreground !== proc.pgid) this.killGroup(foreground, SIGHUP)
      }
    }

    // Host-spawned processes and orphans are reaped now; children stay zombies until their parent
    // waits, and a dying parent reaps its zombies.
    const parent = this.procs.get(proc.ppid)
    if (!parent || parent.state === 'exited') this.procs.delete(proc.pid)
    for (const child of this.procs.values()) {
      if (child.ppid === proc.pid && child.state === 'exited') this.procs.delete(child.pid)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Syscalls

  private async dispatch(proc: Process, request: SyscallRequest, channel: Channel): Promise<void> {
    if (request?.t !== 'sys' || proc.state === 'exited') return
    if (request.name === 'exit') {
      // exit from a thread ends the thread (process.exit() in a worker); from the main thread, the process.
      if (channel.thread) this.endThread(proc, channel.thread, Number(request.args[0]) | 0)
      else this.terminate(proc, Number(request.args[0]) | 0)
      return
    }
    // While the channel acts as a vfork child, its syscalls are the child's.
    const target = channel.acting.at(-1) ?? proc
    let errno = 0
    let value: SyscallValue
    let call: ReturnType<Process['beginCall']> | undefined
    try {
      if (!Object.hasOwn(this.handlers, request.name)) throw kerr('ENOSYS', request.name)
      // A stopped process's syscalls wait for SIGCONT (job control).
      if (target.stopped) await target.whenContinued()
      // A WASI process blocks in one syscall at a time, which a signal for its handlers interrupts.
      if (request.sync && target.personality === 'wasi' && !channel.thread) call = target.beginCall()
      const handler = this.handlers[request.name] as AnyHandler
      value = await handler(target, ...request.args)
    } catch (error) {
      if (error instanceof KernelError) {
        errno = error.errno
        // Handlers installed with SA_RESTART restart the call, except those Linux never restarts.
        if (errno === Errno.EINTR && call?.restarts() && !NEVER_RESTARTED.has(request.name)) errno = Errno.ERESTARTSYS
      } else {
        errno = Errno.EIO
        console.error(`[kernel] ${request.name} failed`, error)
      }
    } finally {
      call?.end()
    }
    // The process (or thread) may have ended while the syscall was pending.
    if (!proc.alive || (channel.thread && !channel.thread.alive)) return
    if (request.sync) {
      completeSync(channel.page, errno, value)
    } else {
      const reply: SyscallReply = { t: 'ret', id: request.id, errno, value }
      channel.port.postMessage(reply)
    }
  }

  private readonly handlers: Handlers = {
    open: (proc, path, flags, mode = 0o666, dirfd = AT_FDCWD) =>
      proc.allocFd(this.openPath(this.resolveAt(proc, dirfd, path), flags | 0, mode, proc), 0, (flags & O_CLOEXEC) !== 0),

    close: (proc, fd) => {
      proc.closeFd(fd)
      return 0
    },

    read: (proc, fd, length) => {
      // Every syscall page has the same capacity; a vfork child uses its parent's.
      const max = Math.max(0, Math.min(length | 0, this.pageBytes))
      const file = proc.getFd(fd)
      // Terminal reads depend on who reads: only the foreground group gets input.
      if (file instanceof PtySlave) return file.pty.read(max, proc.signal, proc)
      return file.read(max, proc.signal)
    },

    write: (proc, fd, data) => {
      if (!(data instanceof Uint8Array)) throw kerr('EINVAL')
      return proc.getFd(fd).write(data, proc.signal)
    },

    seek: (proc, fd, offset, whence) => proc.getFd(fd).seek(offset, whence),

    ftruncate: (proc, fd, length) => {
      proc.getFd(fd).truncate(length)
      return 0
    },

    fstat: (proc, fd) => proc.getFd(fd).stat(),

    stat: (proc, path, dirfd = AT_FDCWD) => this.fs.stat(this.fs.lookup(this.resolveAt(proc, dirfd, path))),

    lstat: (proc, path, dirfd = AT_FDCWD) => this.fs.stat(this.fs.lookup(this.resolveAt(proc, dirfd, path), false)),

    readlink: (proc, path, dirfd = AT_FDCWD) => this.fs.readlink(this.resolveAt(proc, dirfd, path)),

    realpath: (proc, path) => this.fs.realpath(this.resolveAt(proc, AT_FDCWD, path)),

    symlink: (proc, target, path, dirfd = AT_FDCWD) => {
      if (typeof target !== 'string') throw kerr('EINVAL')
      const link = this.resolveAt(proc, dirfd, path)
      this.fs.symlink(target, link)
      this.events.emit({ type: 'fs.change', op: 'create', path: link })
      return 0
    },

    link: (proc, from, to, fromDirfd = AT_FDCWD, toDirfd = AT_FDCWD) => {
      const target = this.resolveAt(proc, toDirfd, to)
      this.fs.hardlink(this.resolveAt(proc, fromDirfd, from), target)
      this.events.emit({ type: 'fs.change', op: 'create', path: target })
      return 0
    },

    getdents: (proc, fd) => proc.getFd(fd).getdents(),

    mkdir: (proc, path, mode = 0o777, dirfd = AT_FDCWD) => {
      const target = this.resolveAt(proc, dirfd, path)
      this.fs.mkdir(target, mode & 0o777 & ~proc.umask)
      this.events.emit({ type: 'fs.change', op: 'mkdir', path: target })
      return 0
    },

    unlink: (proc, path, dirfd = AT_FDCWD) => {
      const target = this.resolveAt(proc, dirfd, path)
      this.fs.unlink(target)
      this.events.emit({ type: 'fs.change', op: 'unlink', path: target })
      return 0
    },

    rmdir: (proc, path, dirfd = AT_FDCWD) => {
      const target = this.resolveAt(proc, dirfd, path)
      this.fs.rmdir(target)
      this.events.emit({ type: 'fs.change', op: 'rmdir', path: target })
      return 0
    },

    rename: (proc, from, to, fromDirfd = AT_FDCWD, toDirfd = AT_FDCWD) => {
      const source = this.resolveAt(proc, fromDirfd, from)
      const target = this.resolveAt(proc, toDirfd, to)
      this.fs.rename(source, target)
      this.events.emit({ type: 'fs.change', op: 'rename', path: source, to: target })
      return 0
    },

    getcwd: (proc) => proc.cwd,

    chdir: (proc, path) => {
      const target = this.resolveAt(proc, AT_FDCWD, path)
      if (this.fs.lookup(target).kind !== 'dir') throw kerr('ENOTDIR', target)
      proc.cwd = target
      return 0
    },

    pipe: (proc) => {
      const [reader, writer] = this.pipe()
      return [proc.allocFd(reader), proc.allocFd(writer)]
    },

    spawn: (proc, argv, request = {}) => {
      if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === 'string')) throw kerr('EINVAL')
      const fds = request.fds ?? [0, 1, 2]
      const stdio = [0, 1, 2].map((i) => (fds[i] >= 0 ? proc.getFd(fds[i]) : undefined))
      const cwd = request.cwd === undefined ? proc.cwd : this.resolveAt(proc, AT_FDCWD, request.cwd)
      const env = request.env ?? proc.env
      // Detached children start a session of their own (setsid). Others stay in the caller's
      // session, in its group, a new group (pgid 0), or a given group of the same session.
      if (request.detached) return this.spawn(argv, { cwd, env, stdio, ppid: proc.pid, umask: proc.umask }).pid
      let pgid: number | undefined = proc.pgid
      if (request.pgid !== undefined) {
        pgid = request.pgid === 0 ? undefined : request.pgid
        // A group of another session is off limits. One whose members have all exited may be
        // rejoined: a pipeline's first stage can end before the last one starts.
        if (pgid !== undefined && this.processes.some((member) => member.pgid === pgid && member.sid !== proc.sid)) throw kerr('EPERM')
      }
      return this.spawn(argv, { cwd, env, stdio, ppid: proc.pid, pgid, sid: proc.sid, umask: proc.umask }).pid
    },

    kill: (proc, pid, signal) => {
      // As kill(2): 0 is the caller's group, a negative pid the group -pid.
      if (pid <= 0) {
        const pgid = pid === 0 ? proc.pgid : -pid
        const members = this.processes.filter((member) => member.pgid === pgid && member.alive)
        if (!members.length) throw kerr('ESRCH')
        if (signal !== 0) this.killGroup(pgid, signal | 0)
        return 0
      }
      // A child that exited exists until its parent waits for it: signalling it succeeds, as on
      // Linux, and does nothing.
      const target = this.procs.get(pid)
      if (!target) throw kerr('ESRCH')
      if (signal !== 0) this.deliver(target, signal | 0)
      return 0
    },

    sigaction: (proc, signal, action, restart = false) => {
      if (!isValidSignal(signal) || signal === SIGKILL || signal === 19 /* SIGSTOP */) throw kerr('EINVAL')
      if (action !== 'default' && action !== 'ignore' && action !== 'handle') throw kerr('EINVAL')
      const previous: SignalAction = proc.dispositions.get(signal) ?? 'default'
      if (action === 'default') proc.dispositions.delete(signal)
      else proc.dispositions.set(signal, action)
      if (action === 'handle' && restart) proc.restart.add(signal)
      else proc.restart.delete(signal)
      // Ignoring a signal discards it if it is pending, as on Linux.
      if (action === 'ignore' && proc.pending.includes(signal)) proc.pending.splice(proc.pending.indexOf(signal), 1)
      return previous
    },

    setsid: (proc) => {
      if (this.processes.some((member) => member.pgid === proc.pid && member.alive)) throw kerr('EPERM')
      proc.sid = proc.pid
      proc.pgid = proc.pid
      return proc.pid
    },

    getsid: (proc, pid) => {
      const target = pid === 0 ? proc : this.procs.get(pid)
      if (!target) throw kerr('ESRCH')
      return target.sid
    },

    setpgid: (proc, pid, pgid) => {
      const target = pid === 0 ? proc : this.procs.get(pid)
      if (!target || (target !== proc && target.ppid !== proc.pid)) throw kerr('ESRCH')
      if (target.sid !== proc.sid || target.pid === target.sid) throw kerr('EPERM')
      const group = pgid === 0 ? target.pid : pgid
      if (group !== target.pid && !this.processes.some((member) => member.pgid === group && member.sid === proc.sid)) throw kerr('EPERM')
      target.pgid = group
      return 0
    },

    ioctl: (proc, fd, request, arg) => this.ioctl(proc, proc.getFd(fd), request, arg),

    openpty: (proc, size) => {
      const { master, slave } = this.openpty(size && { rows: size.rows | 0, cols: size.cols | 0 })
      return [proc.allocFd(master), proc.allocFd(slave)]
    },

    waitStatus: async (proc, pid) => {
      const child = this.procs.get(pid)
      if (!child || child.ppid !== proc.pid) throw kerr('ECHILD')
      const code = await child.exited
      this.procs.delete(pid)
      return child.termSignal === null ? [code, null] : [null, child.termSignal]
    },

    spawnSync: (proc, argv, request) => this.spawnSync(proc, argv, request),

    listen: (proc, address, port) => {
      if (typeof address !== 'string') throw kerr('EINVAL')
      const listener = this.net.listen(address, Number(port), proc.pid)
      return [proc.allocFd(listener), listener.local.port]
    },

    accept: async (proc, fd) => {
      const listener = proc.getFd(fd)
      if (!(listener instanceof Listener)) throw kerr(listener.type === 'socket' ? 'EINVAL' : 'ENOTSOCK')
      const socket = await listener.accept(proc.signal)
      return this.installSocket(proc, socket)
    },

    connect: (proc, address, port) => {
      if (typeof address !== 'string') throw kerr('EINVAL')
      return this.installSocket(proc, this.net.connect(address, Number(port)))
    },

    extract: (proc, archive, dir, options = {}) => {
      if (!(archive instanceof Uint8Array)) throw kerr('EINVAL')
      return this.extract(archive, this.resolveAt(proc, AT_FDCWD, dir), options)
    },

    watch: (proc, path, recursive) => {
      const target = this.resolveAt(proc, AT_FDCWD, path)
      const node = this.fs.lookup(target)
      return proc.allocFd(new Watcher(this.watchers, target, node.kind === 'dir', Boolean(recursive)))
    },

    threadSpawn: (proc, request, port) => {
      if (!(port instanceof MessagePort)) throw kerr('EINVAL', 'threadSpawn needs a MessagePort')
      if (request?.id !== undefined && proc.threads.has(request.id)) throw kerr('EEXIST', `thread ${request.id}`)
      return this.spawnThread(proc, request?.env ?? proc.env, request?.options ?? {}, port, request?.id)
    },

    threadWait: async (proc, id) => {
      const thread = proc.threads.get(id)
      if (!thread) throw kerr('ESRCH', `thread ${id}`)
      const code = await thread.exited
      proc.threads.delete(id)
      return code
    },

    threadTerminate: (proc, id) => {
      const thread = proc.threads.get(id)
      if (!thread) throw kerr('ESRCH', `thread ${id}`)
      this.endThread(proc, thread, 1)
      return 0
    },

    shutdown: (proc, fd) => {
      const socket = proc.getFd(fd)
      if (!(socket instanceof Socket)) throw kerr(socket.type === 'socket' ? 'ENOTCONN' : 'ENOTSOCK')
      socket.shutdown()
      return 0
    },

    dup: (proc, fd, min = 0, cloexec = false) => {
      if (!Number.isInteger(min) || min < 0 || min >= MAX_FDS) throw kerr('EINVAL')
      return proc.allocFd(proc.getFd(fd).retain(), min, Boolean(cloexec))
    },

    dup2: (proc, fd, to) => {
      const file = proc.getFd(fd)
      if (fd !== to) proc.setFd(to, file.retain())
      return to
    },

    fdflags: (proc, fd, cloexec) => {
      proc.getFd(fd)
      if (cloexec === true) proc.cloexec.add(fd)
      else if (cloexec === false) proc.cloexec.delete(fd)
      return proc.cloexec.has(fd) ? 1 : 0
    },

    chmod: (proc, path, mode, dirfd = AT_FDCWD) => {
      const target = this.nodeAt(proc, path, dirfd)
      if (!target) return 0
      target.node.mode = (target.node.mode & ~0o7777) | (mode & 0o7777)
      target.node.ctimeMs = Date.now()
      // A change of mode or times reports as a write: watchers and workspaces see the file change.
      this.events.emit({ type: 'fs.change', op: 'write', path: target.path })
      return 0
    },

    utimes: (proc, path, atimeMs, mtimeMs, dirfd = AT_FDCWD, follow = true) => {
      const target = this.nodeAt(proc, path, dirfd, follow)
      if (!target) return 0
      if (typeof atimeMs === 'number') target.node.atimeMs = atimeMs
      if (typeof mtimeMs === 'number') target.node.mtimeMs = mtimeMs
      target.node.ctimeMs = Date.now()
      this.events.emit({ type: 'fs.change', op: 'write', path: target.path })
      return 0
    },

    poll: async (proc, fds, timeout) => {
      if (!Array.isArray(fds)) throw kerr('EINVAL')
      const signal = proc.signal
      const deadline = timeout >= 0 ? Date.now() + timeout : Infinity
      for (;;) {
        const ready = this.pollFds(proc, fds)
        if (ready.some(([revents]) => revents) || Date.now() >= deadline) return ready
        const files = fds.flatMap(([fd]) => proc.fds[fd] ?? [])
        await this.readinessChange(files, deadline, signal)
      }
    },

    vfork: (proc) => {
      const channel = proc.channel
      if (!channel || channel.thread) throw kerr('ENOSYS')
      const child = new Process({ pid: this.nextPid++, ppid: proc.pid, pgid: proc.pgid, sid: proc.sid, argv: [...proc.argv], env: { ...proc.env }, cwd: proc.cwd })
      child.personality = proc.personality
      child.execPath = proc.execPath
      child.state = 'running'
      child.channel = channel
      proc.fds.forEach((file, fd) => {
        if (file) child.fds[fd] = file.retain()
      })
      for (const fd of proc.cloexec) child.cloexec.add(fd)
      for (const [signal, action] of proc.dispositions) child.dispositions.set(signal, action)
      for (const signal of proc.restart) child.restart.add(signal)
      child.umask = proc.umask
      this.procs.set(child.pid, child)
      channel.acting.push(child)
      this.events.emit({ type: 'process.spawn', pid: child.pid, ppid: proc.pid, argv: child.argv, cwd: child.cwd })
      return child.pid
    },

    vforkExit: (proc, code) => {
      const channel = proc.channel
      if (!channel || channel.acting.at(-1) !== proc) throw kerr('EINVAL')
      channel.acting.pop()
      proc.channel = undefined
      this.terminate(proc, Number(code) | 0)
      this.resumeVforkParent(channel)
      return 0
    },

    execve: (proc, file, argv, env, search) => {
      if (typeof file !== 'string' || !Array.isArray(argv) || !argv.every((arg) => typeof arg === 'string')) throw kerr('EINVAL')
      if (typeof env !== 'object' || env === null) throw kerr('EINVAL')
      if (!proc.alive) throw kerr('ESRCH')
      const variables = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)]))
      const exe = resolveFile(this.fs, file, argv, proc.cwd, variables.PATH ?? DEFAULT_PATH, search)
      this.exec(proc, exe, variables)
      return 0
    },

    wait4: async (proc, pid, options) => {
      for (;;) {
        const children = this.processes.filter(
          (child) =>
            child.ppid === proc.pid &&
            (pid > 0 ? child.pid === pid : pid === -1 ? true : pid === 0 ? child.pgid === proc.pgid : child.pgid === -pid),
        )
        if (!children.length) throw kerr('ECHILD')
        for (const child of children) {
          if (child.state === 'exited') {
            this.procs.delete(child.pid)
            const status = child.termSignal === null ? waitStatus({ code: child.exitCode ?? 0 }) : waitStatus({ signal: child.termSignal })
            return [child.pid, status]
          }
          if (child.change === 'stopped' && options & WUNTRACED) {
            child.change = undefined
            return [child.pid, waitStatus({ stopped: child.stopSignal })]
          }
          if (child.change === 'continued' && options & WCONTINUED) {
            child.change = undefined
            return [child.pid, waitStatus({ continued: true })]
          }
        }
        if (options & WNOHANG) return [0, 0]
        await this.childChange(proc)
      }
    },

    umask: (proc, mask) => {
      const previous = proc.umask
      if (typeof mask === 'number') proc.umask = mask & 0o777
      return previous
    },

    getpgid: (proc, pid) => {
      const target = pid === 0 ? proc : this.procs.get(pid)
      if (!target) throw kerr('ESRCH')
      return target.pgid
    },

    pause: (proc) =>
      new Promise<number>((_, reject) => {
        const signal = proc.signal
        if (signal.aborted) return reject(kerr('EINTR'))
        signal.addEventListener('abort', () => reject(kerr('EINTR')), { once: true })
      }),

    takeSignals: (proc) => {
      if (proc.channel) clearBell(proc.channel.page)
      const taken: number[] = []
      for (const signal of proc.pending.splice(0)) {
        // A signal whose handler was removed meanwhile takes its action now.
        if (proc.dispositions.get(signal) === 'handle') taken.push(signal)
        else this.deliver(proc, signal)
      }
      return taken
    },

    wait: async (proc, pid) => {
      const child = this.procs.get(pid)
      if (!child || child.ppid !== proc.pid) throw kerr('ECHILD')
      const code = await child.exited
      this.procs.delete(pid)
      return code
    },
  }

  /** spawnSync, run entirely inside the kernel so the blocked caller can't deadlock on pipes. */
  private async spawnSync(proc: Process, argv: string[], request: SpawnSyncRequest): Promise<Uint8Array> {
    const capacity = this.pageBytes - SPAWN_SYNC_HEADER_BYTES
    const maxBuffer = Math.min(request.maxBuffer ?? capacity, capacity)
    const held: OpenFile[] = []
    const captured: (Promise<Uint8Array> | undefined)[] = [undefined, undefined, undefined]
    let overflow = false
    let child: Process | undefined
    const stdio = [0, 1, 2].map((fd) => {
      const mode = request.stdio[fd] ?? 'pipe'
      if (mode === 'ignore') return undefined
      if (typeof mode === 'number') return proc.getFd(mode)
      const [reader, writer] = this.pipe()
      held.push(reader, writer)
      if (fd === 0) {
        Promise.resolve(writer.write(request.input ?? new Uint8Array(0)))
          .catch(() => {})
          .finally(() => writer.release())
        held.splice(held.indexOf(writer), 1)
        return reader
      }
      captured[fd] = (async () => {
        const chunks: Uint8Array[] = []
        let total = 0
        for (let chunk = await reader.read(64 * 1024); chunk.length; chunk = await reader.read(64 * 1024)) {
          total += chunk.length
          if (total > maxBuffer) {
            overflow = true
            if (child) this.deliver(child, request.killSignal ?? 15)
            break
          }
          chunks.push(chunk)
        }
        const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
        let offset = 0
        for (const chunk of chunks) {
          out.set(chunk, offset)
          offset += chunk.length
        }
        return out
      })()
      return writer
    })

    const header = new Int32Array(SPAWN_SYNC_HEADER_BYTES / 4)
    try {
      const cwd = request.cwd === undefined ? proc.cwd : this.resolveAt(proc, AT_FDCWD, request.cwd)
      child = this.spawn(argv, { cwd, env: request.env ?? proc.env, stdio, ppid: proc.pid, pgid: proc.pgid })
    } catch (error) {
      for (const file of held) file.release()
      header[3] = error instanceof KernelError ? error.errno : Errno.EIO
      return new Uint8Array(header.buffer)
    }
    // The child holds its own references now; ours would keep its pipes from reaching EOF.
    for (const file of held) if (file instanceof PipeWriter) file.release()

    const timer =
      request.timeout && request.timeout > 0
        ? setTimeout(() => this.deliver(child!, request.killSignal ?? 15), request.timeout)
        : undefined
    const code = await child.exited
    if (timer !== undefined) clearTimeout(timer)
    const [stdout = new Uint8Array(0), stderr = new Uint8Array(0)] = await Promise.all([captured[1], captured[2]])
    for (const file of held) if (file instanceof PipeReader) file.release()
    this.procs.delete(child.pid)

    header[0] = child.pid
    header[1] = child.termSignal === null ? code : -1
    header[2] = child.termSignal ?? 0
    header[3] = overflow ? Errno.ENOBUFS : 0
    header[4] = stdout.length
    header[5] = stderr.length
    const out = new Uint8Array(SPAWN_SYNC_HEADER_BYTES + stdout.length + stderr.length)
    out.set(new Uint8Array(header.buffer))
    out.set(stdout, SPAWN_SYNC_HEADER_BYTES)
    out.set(stderr, SPAWN_SYNC_HEADER_BYTES + stdout.length)
    return out
  }

  private installSocket(proc: Process, socket: Socket): SocketInfo {
    // An accept can complete after its process died; the connection must not leak.
    if (!proc.alive) {
      socket.release()
      throw kerr('EBADF')
    }
    return { fd: proc.allocFd(socket), local: socket.local, peer: socket.peer }
  }

  /** The node `path` names relative to `dirfd`, or the file `dirfd` itself (undefined: not a file). */
  private nodeAt(proc: Process, path: string | null, dirfd: number, follow = true): { node: VNode; path: string } | undefined {
    if (path === null) {
      const file = proc.getFd(dirfd)
      return file instanceof FileHandle || file instanceof DirHandle ? { node: file.node, path: file.path } : undefined
    }
    const resolved = this.resolveAt(proc, dirfd, path)
    return { node: this.fs.lookup(resolved, follow), path: resolved }
  }

  private resolveAt(proc: Process, dirfd: number, path: string): string {
    if (typeof path !== 'string') throw kerr('EINVAL')
    if (!path) throw kerr('ENOENT')
    if (path.startsWith('/')) return normalize(path)
    if (dirfd === AT_FDCWD) return resolve(proc.cwd, path)
    const dir = proc.getFd(dirfd)
    if (!(dir instanceof DirHandle)) throw kerr('ENOTDIR')
    return resolve(dir.path, path)
  }

  private openPath(path: string, flags: number, mode: number, proc?: Process): OpenFile {
    const alias = proc && STDIO_ALIASES.get(path)
    if (proc && alias !== undefined) return proc.getFd(alias).retain()

    let node = this.fs.tryLookup(path)
    if (!node) {
      if (!(flags & O_CREAT)) throw kerr('ENOENT', path)
      // Creating through a dangling symbolic link creates its target, as on Linux.
      const link = this.fs.tryLookup(path, false)
      const target = link?.kind === 'symlink' ? resolve(dirname(path), link.target) : path
      node = this.fs.createFile(target, mode & 0o777 & ~(proc?.umask ?? DEFAULT_UMASK))
      this.events.emit({ type: 'fs.change', op: 'create', path: target })
    } else if (flags & O_CREAT && flags & O_EXCL) {
      throw kerr('EEXIST', path)
    }
    if (node.kind === 'symlink') throw kerr('ELOOP', path)

    const access = flags & O_ACCMODE
    if (node.kind === 'dir') {
      if (access !== O_RDONLY) throw kerr('EISDIR', path)
      return new DirHandle(this.fs, node, path, flags)
    }
    if (flags & O_DIRECTORY) throw kerr('ENOTDIR', path)
    if (node.kind === 'dev') return new DeviceHandle(node.device, flags)

    const file = new FileHandle(this.fs, node, path, flags, (changed) =>
      this.events.emit({ type: 'fs.change', op: 'write', path: changed }),
    )
    if (flags & O_TRUNC && access !== O_RDONLY) {
      if (node.size > 0) file.truncate(0)
      else file.markDirty()
    }
    return file
  }
}
