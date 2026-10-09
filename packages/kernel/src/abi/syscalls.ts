import type { Dirent, Stat } from './constants.ts'
import type { ExtractOptions } from '../kernel/extract.ts'
import type { SignalAction, WinSize } from './signals.ts'

export interface SpawnSyncRequest {
  cwd?: string
  env?: Record<string, string>
  /** Per stdio slot: 'pipe' (captured, or fed from `input` for fd 0), 'ignore', or a caller fd. */
  stdio: ('pipe' | 'ignore' | number)[]
  input?: Uint8Array
  /** Milliseconds; the child is killed with `killSignal` when exceeded. */
  timeout?: number
  killSignal?: number
  /** Bytes per captured stream before the child is killed (ENOBUFS). */
  maxBuffer?: number
}

/**
 * spawnSync's result, packed as bytes: an Int32 header [pid, status, signal, errno, stdoutLength,
 * stderrLength] followed by stdout and stderr. status is -1 when the child died from a signal;
 * errno is non-zero when the child couldn't be started or exceeded maxBuffer.
 */
export const SPAWN_SYNC_HEADER_BYTES = 24

export interface SpawnRequest {
  /** Working directory for the child; defaults to the caller's. */
  cwd?: string
  /** Environment for the child; defaults to the caller's. */
  env?: Record<string, string>
  /** Caller fds that become the child's 0, 1 and 2. A negative value means /dev/null. */
  fds?: [number, number, number]
  /** Start a new session and process group (setsid), as Node's `detached` does. */
  detached?: boolean
  /**
   * The child's process group, as posix_spawn's POSIX_SPAWN_SETPGROUP: 0 starts a new group led by
   * the child, another value joins that group in the caller's session. A shell runs each job in
   * its own group.
   */
  pgid?: number
}

export type AddressFamily = 'IPv4' | 'IPv6'

export interface SocketAddress {
  address: string
  family: AddressFamily
  port: number
}

/** A connected socket: its fd plus both ends' addresses. */
export interface SocketInfo {
  fd: number
  local: SocketAddress
  peer: SocketAddress
}

/**
 * The kernel syscall surface, as seen from a process. This is the single source of truth for the
 * names, arguments and results that cross the process/kernel boundary. `exit` is handled separately
 * because it never returns.
 */
export interface Syscalls {
  open(path: string, flags: number, mode?: number, dirfd?: number): number
  close(fd: number): number
  read(fd: number, length: number): Uint8Array
  write(fd: number, data: Uint8Array): number
  seek(fd: number, offset: number, whence: number): number
  ftruncate(fd: number, length: number): number
  fstat(fd: number): Stat
  stat(path: string, dirfd?: number): Stat
  /** Like stat, but a symbolic link describes itself. */
  lstat(path: string, dirfd?: number): Stat
  readlink(path: string, dirfd?: number): string
  /** Creates `path` as a symbolic link to `target`, which is stored as given. */
  symlink(target: string, path: string, dirfd?: number): number
  /** Creates a hard link `to` for the file at `from`. */
  link(from: string, to: string, fromDirfd?: number, toDirfd?: number): number
  /** The canonical absolute path, with every symbolic link resolved. */
  realpath(path: string): string
  getdents(fd: number): Dirent[]
  mkdir(path: string, mode?: number, dirfd?: number): number
  unlink(path: string, dirfd?: number): number
  rmdir(path: string, dirfd?: number): number
  rename(from: string, to: string, fromDirfd?: number, toDirfd?: number): number
  getcwd(): string
  chdir(path: string): number
  pipe(): [number, number]
  spawn(argv: string[], request?: SpawnRequest): number
  wait(pid: number): number
  /**
   * Sends a signal. Signal 0 only checks that the process exists. A negative pid targets the
   * process group -pid, and 0 the caller's own group. The target's disposition decides what
   * happens: the default action (terminating with 128 + signal for most signals), nothing, or
   * delivery to its handler.
   */
  kill(pid: number, signal: number): number
  /**
   * Sets how the caller treats `signal`; returns the previous disposition. SIGKILL can't change.
   * `restart` (SA_RESTART): a syscall the handled signal interrupts is made again afterwards.
   */
  sigaction(signal: number, action: SignalAction, restart?: boolean): SignalAction
  /** Starts a new session and process group led by the caller; EPERM for a group leader. */
  setsid(): number
  /** The session of `pid` (0: the caller). */
  getsid(pid: number): number
  /** Moves `pid` (0: the caller) into group `pgid` (0: its own) within its session. */
  setpgid(pid: number, pgid: number): number
  /**
   * Terminal requests in Linux's numbering (TCGETS, TCSETS, TIOCGWINSZ, TIOCSPGRP, …): termios
   * and window sizes travel as objects. ENOTTY for an fd that isn't a terminal.
   */
  ioctl(fd: number, request: number, arg?: unknown): unknown
  /** Creates a pseudo-terminal: [master fd, slave fd]. */
  openpty(size?: WinSize): [master: number, slave: number]
  /** Like wait, but distinguishes exit codes from signals: [code, signal] (one of them is null). */
  waitStatus(pid: number): [code: number | null, signal: number | null]
  /** Runs a child to completion, inside the kernel (see SPAWN_SYNC_HEADER_BYTES). */
  spawnSync(argv: string[], request: SpawnSyncRequest): Uint8Array
  /** Listens for virtual TCP connections (ADR-0014). Port 0 picks a free port. */
  listen(address: string, port: number): [fd: number, port: number]
  /** Waits for the next connection on a listening socket. */
  accept(fd: number): SocketInfo
  /** Connects to a local listener; fails with ECONNREFUSED when nothing listens on `port`. */
  connect(address: string, port: number): SocketInfo
  /** Closes a socket's write direction (SHUT_WR): the peer reads EOF. */
  shutdown(fd: number): number
  /**
   * Unpacks a (gzipped) tar archive into `dir`, after checking `integrity` when given (ADR-0015).
   * Returns the number of files written; EBADMSG when the integrity check fails.
   */
  extract(archive: Uint8Array, dir: string, options?: ExtractOptions): number
  /**
   * Starts a thread of the calling process: a Worker that shares its fds, cwd and pid. `port`
   * (transferred) reaches the thread in its boot message. Returns the thread id.
   */
  threadSpawn(request: ThreadSpawnRequest, port: MessagePort): number
  /** Waits for a thread to end; returns its exit code. */
  threadWait(id: number): number
  /** Stops a thread abruptly (worker.terminate()); it ends with code 1. */
  threadTerminate(id: number): number
  /** Duplicates `fd` onto the lowest free fd ≥ `min` (F_DUPFD); `cloexec` sets FD_CLOEXEC. */
  dup(fd: number, min?: number, cloexec?: boolean): number
  /** Makes `to` another fd for `fd`'s file (dup2), closing what `to` was. FD_CLOEXEC is cleared. */
  dup2(fd: number, to: number): number
  /** FD_CLOEXEC of `fd` (1 or 0); sets it first when `cloexec` is given. */
  fdflags(fd: number, cloexec?: boolean): number
  /** Sets a file's permission bits: `path` relative to `dirfd`, or the file `dirfd` when null. */
  chmod(path: string | null, mode: number, dirfd?: number): number
  /**
   * Sets a file's access and modification times (ms since the epoch; null keeps one): `path`
   * relative to `dirfd`, or the file `dirfd` when null. `follow` false changes a link itself.
   */
  utimes(path: string | null, atimeMs: number | null, mtimeMs: number | null, dirfd?: number, follow?: boolean): number
  /**
   * Readiness of fds, as poll(2): for each [fd, events] the returned [revents, bytes readable].
   * Waits up to `timeout` ms (negative: no limit) for one to become ready.
   */
  poll(fds: [fd: number, events: number][], timeout: number): [revents: number, readable: number][]
  /**
   * Starts a child that shares the caller's memory (vfork, M2c): a copy of its fds, working
   * directory and signal dispositions. The calling thread then acts as the child (its syscalls
   * apply to the child) until the child calls execve or vforkExit. Returns the child's pid.
   */
  vfork(): number
  /** Ends the vfork child the thread acts as, with `code`; the thread is its parent again. */
  vforkExit(code: number): number
  /**
   * Runs `file` in place of the caller's program, with `argv` and `env`. FD_CLOEXEC fds close and
   * handled signals return to their default. `search` is a PATH in which to look for a `file`
   * without a slash. For a vfork child the new program starts in the child's own Worker, and the
   * call returns in the parent; otherwise it doesn't return.
   */
  execve(file: string, argv: string[], env: Record<string, string>, search?: string): number
  /**
   * Waits for a child to change state, as wait4(2): `pid` is a child, -1 any child, 0 any in the
   * caller's group, or -group. `options` are WNOHANG, WUNTRACED and WCONTINUED. Returns the child
   * and its status in Linux's encoding, or [0, 0] with WNOHANG when none has changed.
   */
  wait4(pid: number, options: number): [pid: number, status: number]
  /** The process group of `pid` (0: the caller). */
  getpgid(pid: number): number
  /** Sets the file creation mask (unless null); returns the previous one. */
  umask(mask: number | null): number
  /** Waits until a signal interrupts it (EINTR). */
  pause(): number
  /**
   * Takes the signals waiting for the caller's handlers, in arrival order (WASI processes, between
   * syscalls). Waits while the caller is stopped.
   */
  takeSignals(): number[]
  /**
   * Watches a file or directory (like inotify). Reading the returned fd blocks until changes arrive,
   * as newline-separated JSON: {"event": "rename" | "change", "path": relative name}.
   */
  watch(path: string, recursive: boolean): number
}

export interface ThreadSpawnRequest {
  /** The thread's id, allocated by the caller (worker_threads needs it synchronously). */
  id?: number
  env: Record<string, string>
  /** Passed through to the thread's boot message. */
  options?: Record<string, unknown>
}

export type SyscallName = keyof Syscalls
export type SyscallArgs<N extends SyscallName> = Parameters<Syscalls[N]>
export type SyscallReturn<N extends SyscallName> = ReturnType<Syscalls[N]>

/** Anything a syscall can return: a number, bytes, or a JSON-serializable value. */
export type SyscallValue = number | Uint8Array | string | object | undefined
