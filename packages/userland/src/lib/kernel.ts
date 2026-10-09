// The kernel ABI (`process.webcore`), for programs that need more than Node's APIs offer: raw
// pipes and spawn with explicit fds (sh), and unpacking archives in the kernel (npm).

interface WebcoreApi {
  syscall(name: string, ...args: unknown[]): unknown
  syscallAsync(name: string, ...args: unknown[]): Promise<unknown>
}

function api(): WebcoreApi {
  const webcore = (process as unknown as { webcore?: WebcoreApi }).webcore
  if (!webcore) throw new Error("This program needs webcore's kernel (process.webcore is missing)")
  return webcore
}

/** A failed syscall: `code` is the errno name, e.g. ENOENT. */
export interface SysError extends Error {
  code: string
  errno: number
}

export function isSysError(error: unknown, code?: string): error is SysError {
  return error instanceof Error && typeof (error as SysError).code === 'string' && (code === undefined || (error as SysError).code === code)
}

export interface SpawnRequest {
  cwd?: string
  env?: Record<string, string>
  /** Our fds that become the child's 0, 1 and 2. */
  fds?: [number, number, number]
  detached?: boolean
}

export const O_RDONLY = 0
export const O_WRONLY = 1
export const O_RDWR = 2
export const O_CREAT = 0o100
export const O_TRUNC = 0o1000
export const O_APPEND = 0o2000

const encoder = new TextEncoder()

export const sys = {
  pipe: () => api().syscall('pipe') as [read: number, write: number],
  close: (fd: number) => void api().syscall('close', fd),
  open: (path: string, flags: number, mode = 0o666) => api().syscall('open', path, flags, mode) as number,
  read: (fd: number, length = 64 * 1024) => api().syscallAsync('read', fd, length) as Promise<Uint8Array>,
  write: (fd: number, data: Uint8Array | string) => api().syscall('write', fd, typeof data === 'string' ? encoder.encode(data) : data) as number,
  spawn: (argv: string[], request: SpawnRequest) => api().syscall('spawn', argv, request) as number,
  /** [exit code, signal]: one of them is null. */
  waitStatus: (pid: number) => api().syscallAsync('waitStatus', pid) as Promise<[number | null, number | null]>,
  kill: (pid: number, signal: number) => void api().syscall('kill', pid, signal),
  extract: (archive: Uint8Array, dir: string, options: { strip?: number; integrity?: string }) =>
    api().syscallAsync('extract', archive, dir, options) as Promise<number>,
}
