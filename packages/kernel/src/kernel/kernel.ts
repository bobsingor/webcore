import { Errno, KernelError, kerr } from '../abi/errno.ts'
import {
  AT_FDCWD,
  DEFAULT_PATH,
  O_ACCMODE,
  O_CREAT,
  O_DIRECTORY,
  O_EXCL,
  O_RDONLY,
  O_RDWR,
  O_TRUNC,
} from '../abi/constants.ts'
import { completeSync, createPage, DEFAULT_PAGE_BYTES, pageCapacity } from '../abi/page.ts'
import type { BootMessage, SyscallReply, SyscallRequest } from '../abi/protocol.ts'
import { SPAWN_SYNC_HEADER_BYTES } from '../abi/syscalls.ts'
import type { SocketInfo, SpawnSyncRequest, SyscallArgs, SyscallName, SyscallReturn, SyscallValue } from '../abi/syscalls.ts'
import { EventBus } from './events.ts'
import { extractArchive, type ExtractOptions } from './extract.ts'
import { Watcher } from './watch.ts'
import { Listener, Network, Socket } from './net.ts'
import { resolveExecutable, type Executable } from './exec.ts'
import { DeviceHandle, DirHandle, FileHandle, PipeReader, PipeWriter, type OpenFile } from './files.ts'
import { dirname, normalize, resolve } from './path.ts'
import { Pipe } from './pipe.ts'
import { Process, type Channel, type Thread, type WorkerLike } from './process.ts'
import { MemFS, type FileNode } from './vfs.ts'

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
}

export interface SpawnOptions {
  cwd?: string
  env?: Record<string, string>
  /** Files for fds 0, 1 and 2. The kernel takes its own references; gaps get /dev/null. */
  stdio?: readonly (OpenFile | undefined)[]
  ppid?: number
  /** Process group to join. By default a process leads a new group of its own. */
  pgid?: number
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
const UMASK = 0o022
const encoder = new TextEncoder()

export class Kernel {
  readonly fs = new MemFS()
  readonly events = new EventBus()
  /** Virtual TCP: listening ports and connections (ADR-0014). */
  readonly net = new Network(this.events)
  private readonly host: ProcessHost
  private readonly pageBytes: number
  private readonly procs = new Map<number, Process>()
  private readonly modules = new WeakMap<FileNode, { version: number; module: Promise<WebAssembly.Module> }>()
  private readonly assets: Record<string, Uint8Array> = {}
  private readonly watchers = new Set<Watcher>()
  private nextPid = 1

  constructor(options: KernelOptions) {
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
    const proc = new Process({ pid: this.nextPid++, ppid: options.ppid ?? 0, pgid: options.pgid, argv: exe.argv, env, cwd })
    for (let fd = 0; fd < 3; fd++) {
      proc.fds[fd] = options.stdio?.[fd]?.retain() ?? new DeviceHandle('null', O_RDWR)
    }
    this.procs.set(proc.pid, proc)
    this.events.emit({ type: 'process.spawn', pid: proc.pid, ppid: proc.ppid, argv: proc.argv, cwd })
    void this.boot(proc, exe)
    return proc
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

  getProcess(pid: number): Process | undefined {
    return this.procs.get(pid)
  }

  /** Live and zombie processes. */
  get processes(): Process[] {
    return [...this.procs.values()]
  }

  /** Terminates a process as if by `signal` (SIGKILL by default): exit status 128 + signal. */
  kill(pid: number, signal = 9): void {
    const proc = this.procs.get(pid)
    if (proc) this.terminate(proc, 128 + signal, signal)
  }

  /** Signals every live process in a group, as a terminal does for Ctrl+C. */
  killGroup(pgid: number, signal = 9): void {
    for (const proc of [...this.procs.values()]) {
      if (proc.pgid === pgid && proc.alive) this.terminate(proc, 128 + signal, signal)
    }
  }

  shutdown(): void {
    for (const proc of [...this.procs.values()]) this.terminate(proc, 137, 9)
  }

  // ---------------------------------------------------------------------------------------------
  // Process lifecycle

  private async boot(proc: Process, exe: Executable): Promise<void> {
    try {
      const module = exe.personality === 'wasi' ? await this.compile(exe.node) : undefined
      if (proc.state === 'exited') return
      const { channel, port } = this.openChannel(proc)
      proc.page = channel.page
      proc.port = channel.port
      proc.execPath = exe.path
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
    const channel: Channel = { page: createPage(this.pageBytes), port: port1, thread }
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

  private compile(node: FileNode): Promise<WebAssembly.Module> {
    const cached = this.modules.get(node)
    if (cached?.version === node.version) return cached.module
    const module = WebAssembly.compile(node.data.slice(0, node.size))
    this.modules.set(node, { version: node.version, module })
    return module
  }

  /** The process died outside its own control (bad module, Worker error). */
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

  private terminate(proc: Process, code: number, signal: number | null = null): void {
    if (proc.state === 'exited') return
    proc.termSignal = signal
    proc.markExited(code & 0xff)
    proc.closeAll()
    proc.port?.close()
    try {
      proc.worker?.terminate()
    } catch {
      // Already gone.
    }
    for (const thread of [...proc.threads.values()]) this.endThread(proc, thread, code)
    this.events.emit({ type: 'process.exit', pid: proc.pid, code: proc.exitCode! })

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
    let errno = 0
    let value: SyscallValue
    try {
      if (!Object.hasOwn(this.handlers, request.name)) throw kerr('ENOSYS', request.name)
      const handler = this.handlers[request.name] as AnyHandler
      value = await handler(proc, ...request.args)
    } catch (error) {
      if (error instanceof KernelError) {
        errno = error.errno
      } else {
        errno = Errno.EIO
        console.error(`[kernel] ${request.name} failed`, error)
      }
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
      proc.allocFd(this.openPath(this.resolveAt(proc, dirfd, path), flags | 0, mode, proc)),

    close: (proc, fd) => {
      proc.closeFd(fd)
      return 0
    },

    read: (proc, fd, length) => {
      const max = Math.max(0, Math.min(length | 0, pageCapacity(proc.page!)))
      return proc.getFd(fd).read(max, proc.abort.signal)
    },

    write: (proc, fd, data) => {
      if (!(data instanceof Uint8Array)) throw kerr('EINVAL')
      return proc.getFd(fd).write(data, proc.abort.signal)
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
      this.fs.mkdir(target, mode & 0o777 & ~UMASK)
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
      // Children join their parent's group unless detached (setsid).
      const pgid = request.detached ? undefined : proc.pgid
      return this.spawn(argv, { cwd, env: request.env ?? proc.env, stdio, ppid: proc.pid, pgid }).pid
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
      const target = this.procs.get(pid)
      if (!target || !target.alive) throw kerr('ESRCH')
      if (signal !== 0) this.terminate(target, 128 + (signal | 0), signal | 0)
      return 0
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
      const socket = await listener.accept(proc.abort.signal)
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
    const capacity = pageCapacity(proc.page!) - SPAWN_SYNC_HEADER_BYTES
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
            if (child) this.terminate(child, 128 + (request.killSignal ?? 15), request.killSignal ?? 15)
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
        ? setTimeout(() => this.terminate(child!, 128 + (request.killSignal ?? 15), request.killSignal ?? 15), request.timeout)
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
      node = this.fs.createFile(target, mode & 0o777 & ~UMASK)
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
