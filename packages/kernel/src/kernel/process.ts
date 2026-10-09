import { kerr } from '../abi/errno.ts'
import type { Personality } from '../abi/protocol.ts'
import type { SignalAction } from '../abi/signals.ts'
import type { OpenFile } from './files.ts'

export const MAX_FDS = 1024

/** Minimal Worker surface the kernel needs; implemented by each ProcessHost. */
export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void
  terminate(): void
}

export type ProcessState = 'starting' | 'running' | 'exited'

/** One syscall channel: the process's main thread, or one of its threads. */
export interface Channel {
  page: SharedArrayBuffer
  port: MessagePort
  /** The process whose Worker uses this channel. */
  owner: Process
  thread?: Thread
  /**
   * vfork children this channel acts as, innermost last (M2c). Until one calls execve or
   * vforkExit, the channel's syscalls apply to it rather than to the owner.
   */
  acting: Process[]
}

/** A worker_threads thread: another Worker in the same process. */
export interface Thread {
  id: number
  worker?: WorkerLike
  channel?: Channel
  alive: boolean
  /** Resolves with the exit code. */
  exited: Promise<number>
  resolve(code: number): void
}

export class Process {
  readonly pid: number
  readonly ppid: number
  /** Process group: a job that receives terminal signals together, as on Linux. */
  pgid: number
  /** Session: the processes that share a controlling terminal. */
  sid: number
  /** Signals the process ignores or handles; the rest take their default action. */
  readonly dispositions = new Map<number, Exclude<SignalAction, 'default'>>()
  /** Handled signals not yet taken by a WASI process (it takes them between syscalls). */
  readonly pending: number[] = []
  /** Handled signals whose handlers restart an interrupted syscall (SA_RESTART). */
  readonly restart = new Set<number>()
  /** Permission bits that files and directories the process creates don't get. */
  umask = 0o022
  argv: string[]
  env: Record<string, string>
  cwd: string
  personality: Personality = 'node'
  state: ProcessState = 'starting'
  exitCode: number | null = null
  /** Set when the process was terminated by a signal rather than exiting. */
  termSignal: number | null = null
  /** Stopped by a signal (job control): its syscalls wait until SIGCONT. */
  stopped = false
  stopSignal = 0
  /** A change of state that the parent's wait4 hasn't reported yet. */
  change?: 'stopped' | 'continued'
  /** Resolves with the exit code. */
  readonly exited: Promise<number>
  /** Aborted on exit; cancels the process's pending blocking operations. */
  readonly abort = new AbortController()
  readonly fds: (OpenFile | undefined)[] = []
  /** Fds closed by execve (FD_CLOEXEC). */
  readonly cloexec = new Set<number>()
  worker?: WorkerLike
  port?: MessagePort
  page?: SharedArrayBuffer
  /** The channel that runs the process: its own, or its vfork parent's until it calls execve. */
  channel?: Channel
  execPath = ''
  readonly threads = new Map<number, Thread>()
  nextThreadId = 1
  /** The blocking syscall in progress, which a signal interrupts (WASI processes). */
  private call?: AbortController
  private callSignal?: AbortSignal
  /** Whether every signal that interrupted the call restarts it (SA_RESTART). */
  private callRestarts = true
  private continued: (() => void)[] = []
  private resolveExit!: (code: number) => void

  constructor(init: { pid: number; ppid: number; pgid?: number; sid?: number; argv: string[]; env: Record<string, string>; cwd: string }) {
    this.pid = init.pid
    this.ppid = init.ppid
    this.pgid = init.pgid ?? init.pid
    this.sid = init.sid ?? init.pid
    this.argv = init.argv
    this.env = init.env
    this.cwd = init.cwd
    this.exited = new Promise((resolve) => (this.resolveExit = resolve))
  }

  get alive(): boolean {
    return this.state !== 'exited'
  }

  /** What blocking operations of the current syscall wait on: the call's interruption, or exit. */
  get signal(): AbortSignal {
    return this.callSignal ?? this.abort.signal
  }

  /**
   * Starts an interruptible syscall: a signal for the process's handlers cancels it with EINTR,
   * and one already pending cancels it at once. Returns the function that ends it.
   */
  beginCall(): { end(): void; restarts(): boolean } {
    const call = new AbortController()
    this.call = call
    this.callSignal = AbortSignal.any([call.signal, this.abort.signal])
    this.callRestarts = true
    if (this.pending.length) this.interrupt(this.pending.every((signal) => this.restart.has(signal)))
    return {
      end: () => {
        if (this.call !== call) return
        this.call = undefined
        this.callSignal = undefined
      },
      restarts: () => this.callRestarts,
    }
  }

  /** Interrupts the syscall in progress, if any: EINTR, or a restart when `restart` (SA_RESTART). */
  interrupt(restart = false): void {
    if (!this.call) return
    this.callRestarts &&= restart
    this.call.abort()
  }

  /** Resolves once the process is no longer stopped; rejects if it exits first. */
  whenContinued(): Promise<void> {
    if (!this.stopped) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const onExit = () => reject(kerr('ESRCH'))
      this.abort.signal.addEventListener('abort', onExit, { once: true })
      this.continued.push(() => {
        this.abort.signal.removeEventListener('abort', onExit)
        resolve()
      })
    })
  }

  stop(signal: number): void {
    this.stopped = true
    this.stopSignal = signal
    this.change = 'stopped'
  }

  resume(): void {
    this.stopped = false
    this.change = 'continued'
    for (const wake of this.continued.splice(0)) wake()
  }

  /** Installs `file` at the lowest free fd ≥ `min`. Takes ownership of one reference. */
  allocFd(file: OpenFile, min = 0, cloexec = false): number {
    for (let fd = Math.max(0, min); fd < MAX_FDS; fd++) {
      if (!this.fds[fd]) {
        this.fds[fd] = file
        if (cloexec) this.cloexec.add(fd)
        return fd
      }
    }
    file.release()
    throw kerr('EMFILE')
  }

  /** Installs `file` at `fd`, closing what was there (dup2). Takes ownership of one reference. */
  setFd(fd: number, file: OpenFile, cloexec = false): void {
    if (!Number.isInteger(fd) || fd < 0 || fd >= MAX_FDS) {
      file.release()
      throw kerr('EBADF', `fd ${fd}`)
    }
    const previous = this.fds[fd]
    this.fds[fd] = file
    if (cloexec) this.cloexec.add(fd)
    else this.cloexec.delete(fd)
    previous?.release()
  }

  getFd(fd: number): OpenFile {
    const file = Number.isInteger(fd) && fd >= 0 ? this.fds[fd] : undefined
    if (!file) throw kerr('EBADF', `fd ${fd}`)
    return file
  }

  closeFd(fd: number): void {
    const file = this.getFd(fd)
    this.fds[fd] = undefined
    this.cloexec.delete(fd)
    file.release()
  }

  /** execve's part: closes the FD_CLOEXEC fds. */
  closeOnExec(): void {
    for (const fd of [...this.cloexec]) this.closeFd(fd)
  }

  closeAll(): void {
    for (const file of this.fds) file?.release()
    this.fds.length = 0
    this.cloexec.clear()
  }

  markExited(code: number): void {
    this.state = 'exited'
    this.exitCode = code
    this.abort.abort()
    for (const wake of this.continued.splice(0)) wake()
    this.resolveExit(code)
  }
}
