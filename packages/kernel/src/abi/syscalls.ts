import type { Dirent, Stat } from './constants.ts'

export interface SpawnRequest {
  /** Working directory for the child; defaults to the caller's. */
  cwd?: string
  /** Environment for the child; defaults to the caller's. */
  env?: Record<string, string>
  /** Caller fds that become the child's 0, 1 and 2. A negative value means /dev/null. */
  fds?: [number, number, number]
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
}

export type SyscallName = keyof Syscalls
export type SyscallArgs<N extends SyscallName> = Parameters<Syscalls[N]>
export type SyscallReturn<N extends SyscallName> = ReturnType<Syscalls[N]>

/** Anything a syscall can return: a number, bytes, or a JSON-serializable value. */
export type SyscallValue = number | Uint8Array | string | object | undefined
