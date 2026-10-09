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
import type { SyscallArgs, SyscallName, SyscallReturn, SyscallValue } from '../abi/syscalls.ts'
import { EventBus } from './events.ts'
import { resolveExecutable, type Executable } from './exec.ts'
import { DeviceHandle, DirHandle, FileHandle, PipeReader, PipeWriter, type OpenFile } from './files.ts'
import { normalize, resolve } from './path.ts'
import { Pipe } from './pipe.ts'
import { Process, type WorkerLike } from './process.ts'
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
}

export interface SpawnOptions {
  cwd?: string
  env?: Record<string, string>
  /** Files for fds 0, 1 and 2. The kernel takes its own references; gaps get /dev/null. */
  stdio?: readonly (OpenFile | undefined)[]
  ppid?: number
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
  private readonly host: ProcessHost
  private readonly pageBytes: number
  private readonly procs = new Map<number, Process>()
  private readonly modules = new WeakMap<FileNode, { version: number; module: Promise<WebAssembly.Module> }>()
  private nextPid = 1

  constructor(options: KernelOptions) {
    this.host = options.host
    this.pageBytes = options.pageBytes ?? DEFAULT_PAGE_BYTES
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
    const proc = new Process({ pid: this.nextPid++, ppid: options.ppid ?? 0, argv: exe.argv, env, cwd })
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

  getProcess(pid: number): Process | undefined {
    return this.procs.get(pid)
  }

  /** Live and zombie processes. */
  get processes(): Process[] {
    return [...this.procs.values()]
  }

  kill(pid: number, code = 137): void {
    const proc = this.procs.get(pid)
    if (proc) this.terminate(proc, code)
  }

  shutdown(): void {
    for (const proc of [...this.procs.values()]) this.terminate(proc, 137)
  }

  // ---------------------------------------------------------------------------------------------
  // Process lifecycle

  private async boot(proc: Process, exe: Executable): Promise<void> {
    try {
      const module = exe.personality === 'wasi' ? await this.compile(exe.node) : undefined
      if (proc.state === 'exited') return
      const page = createPage(this.pageBytes)
      const { port1, port2 } = new MessageChannel()
      proc.page = page
      proc.port = port1
      port1.addEventListener('message', (event) => void this.dispatch(proc, event.data))
      port1.start()
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
        page,
        port: port2,
      }
      proc.worker.postMessage(boot, [port2])
      proc.state = 'running'
    } catch (error) {
      this.crash(proc, error)
    }
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

  private terminate(proc: Process, code: number): void {
    if (proc.state === 'exited') return
    proc.markExited(code & 0xff)
    proc.closeAll()
    proc.port?.close()
    try {
      proc.worker?.terminate()
    } catch {
      // Already gone.
    }
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

  private async dispatch(proc: Process, request: SyscallRequest): Promise<void> {
    if (request?.t !== 'sys' || proc.state === 'exited') return
    if (request.name === 'exit') {
      this.terminate(proc, Number(request.args[0]) | 0)
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
    // The process may have been killed while the syscall was pending.
    if (!proc.alive) return
    if (request.sync) {
      completeSync(proc.page!, errno, value)
    } else {
      const reply: SyscallReply = { t: 'ret', id: request.id, errno, value }
      proc.port!.postMessage(reply)
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
      return this.spawn(argv, { cwd, env: request.env ?? proc.env, stdio, ppid: proc.pid }).pid
    },

    wait: async (proc, pid) => {
      const child = this.procs.get(pid)
      if (!child || child.ppid !== proc.pid) throw kerr('ECHILD')
      const code = await child.exited
      this.procs.delete(pid)
      return code
    },
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
      node = this.fs.createFile(path, mode & 0o777 & ~UMASK)
      this.events.emit({ type: 'fs.change', op: 'create', path })
    } else if (flags & O_CREAT && flags & O_EXCL) {
      throw kerr('EEXIST', path)
    }

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
