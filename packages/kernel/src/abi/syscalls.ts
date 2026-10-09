import type { Dirent, Stat } from './constants.ts'

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
  /** Signal 0 checks that the process exists; any other signal terminates it with 128 + signal. */
  kill(pid: number, signal: number): number
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
}

export type SyscallName = keyof Syscalls
export type SyscallArgs<N extends SyscallName> = Parameters<Syscalls[N]>
export type SyscallReturn<N extends SyscallName> = ReturnType<Syscalls[N]>

/** Anything a syscall can return: a number, bytes, or a JSON-serializable value. */
export type SyscallValue = number | Uint8Array | string | object | undefined
