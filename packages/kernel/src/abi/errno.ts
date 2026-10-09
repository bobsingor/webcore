// Kernel errno values use Linux numbering (ADR-0003). Personalities translate at the boundary.

export const Errno = {
  EPERM: 1,
  ENOENT: 2,
  ESRCH: 3,
  EINTR: 4,
  EIO: 5,
  ENXIO: 6,
  E2BIG: 7,
  ENOEXEC: 8,
  EBADF: 9,
  ECHILD: 10,
  EAGAIN: 11,
  ENOMEM: 12,
  EACCES: 13,
  EFAULT: 14,
  EBUSY: 16,
  EEXIST: 17,
  EXDEV: 18,
  ENODEV: 19,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  ENFILE: 23,
  EMFILE: 24,
  ENOTTY: 25,
  EFBIG: 27,
  ENOSPC: 28,
  ESPIPE: 29,
  EROFS: 30,
  EMLINK: 31,
  EPIPE: 32,
  ERANGE: 34,
  ENAMETOOLONG: 36,
  ENOSYS: 38,
  ENOTEMPTY: 39,
  ELOOP: 40,
  EOVERFLOW: 75,
  ENOTSOCK: 88,
  EAFNOSUPPORT: 97,
  EADDRINUSE: 98,
  EADDRNOTAVAIL: 99,
  ENETUNREACH: 101,
  ECONNRESET: 104,
  ENOBUFS: 105,
  EISCONN: 106,
  ENOTCONN: 107,
  ETIMEDOUT: 110,
  ECONNREFUSED: 111,
} as const

export type ErrnoName = keyof typeof Errno

const names = new Map<number, ErrnoName>(
  Object.entries(Errno).map(([name, value]) => [value, name as ErrnoName]),
)

// libuv wording, so Node-facing messages match real Node.
const messages: Partial<Record<ErrnoName, string>> = {
  EPERM: 'operation not permitted',
  ENOENT: 'no such file or directory',
  ESRCH: 'no such process',
  EIO: 'i/o error',
  ENOEXEC: 'exec format error',
  EBADF: 'bad file descriptor',
  ECHILD: 'no child processes',
  EAGAIN: 'resource temporarily unavailable',
  EACCES: 'permission denied',
  EBUSY: 'resource busy or locked',
  EEXIST: 'file already exists',
  ENOTDIR: 'not a directory',
  EISDIR: 'illegal operation on a directory',
  EINVAL: 'invalid argument',
  EMFILE: 'too many open files',
  ENOSPC: 'no space left on device',
  ESPIPE: 'invalid seek',
  EPIPE: 'broken pipe',
  ENAMETOOLONG: 'name too long',
  ENOSYS: 'function not implemented',
  ENOTEMPTY: 'directory not empty',
  ELOOP: 'too many symbolic links encountered',
  EOVERFLOW: 'value too large for defined data type',
  ENOTSOCK: 'socket operation on non-socket',
  EAFNOSUPPORT: 'address family not supported',
  EADDRINUSE: 'address already in use',
  EADDRNOTAVAIL: 'address not available',
  ENETUNREACH: 'network is unreachable',
  ECONNRESET: 'connection reset by peer',
  EISCONN: 'socket is already connected',
  ENOTCONN: 'socket is not connected',
  ETIMEDOUT: 'connection timed out',
  ECONNREFUSED: 'connection refused',
}

export function errnoName(errno: number): ErrnoName | 'EUNKNOWN' {
  return names.get(errno) ?? 'EUNKNOWN'
}

export function errnoMessage(errno: number): string {
  const name = names.get(errno)
  return (name && messages[name]) ?? 'unknown error'
}

/** Thrown inside the kernel; becomes an errno on the wire. */
export class KernelError extends Error {
  readonly errno: number

  constructor(errno: number, detail?: string) {
    super(`${errnoName(errno)}: ${errnoMessage(errno)}${detail ? `, ${detail}` : ''}`)
    this.errno = errno
  }
}

export function kerr(name: ErrnoName, detail?: string): KernelError {
  return new KernelError(Errno[name], detail)
}
