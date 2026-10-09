import { kerr } from '../abi/errno.ts'
import type { SignalAction } from '../abi/signals.ts'
import type { OpenFile } from './files.ts'

const MAX_FDS = 1024

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
  thread?: Thread
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
  readonly argv: string[]
  readonly env: Record<string, string>
  cwd: string
  state: ProcessState = 'starting'
  exitCode: number | null = null
  /** Set when the process was terminated by a signal rather than exiting. */
  termSignal: number | null = null
  /** Resolves with the exit code. */
  readonly exited: Promise<number>
  /** Aborted on exit; cancels the process's pending blocking operations. */
  readonly abort = new AbortController()
  readonly fds: (OpenFile | undefined)[] = []
  worker?: WorkerLike
  port?: MessagePort
  page?: SharedArrayBuffer
  execPath = ''
  readonly threads = new Map<number, Thread>()
  nextThreadId = 1
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

  /** Installs `file` at the lowest free fd. Takes ownership of one reference. */
  allocFd(file: OpenFile, min = 0): number {
    for (let fd = min; fd < MAX_FDS; fd++) {
      if (!this.fds[fd]) {
        this.fds[fd] = file
        return fd
      }
    }
    file.release()
    throw kerr('EMFILE')
  }

  getFd(fd: number): OpenFile {
    const file = Number.isInteger(fd) && fd >= 0 ? this.fds[fd] : undefined
    if (!file) throw kerr('EBADF', `fd ${fd}`)
    return file
  }

  closeFd(fd: number): void {
    const file = this.getFd(fd)
    this.fds[fd] = undefined
    file.release()
  }

  closeAll(): void {
    for (const file of this.fds) file?.release()
    this.fds.length = 0
  }

  markExited(code: number): void {
    this.state = 'exited'
    this.exitCode = code
    this.abort.abort()
    this.resolveExit(code)
  }
}
