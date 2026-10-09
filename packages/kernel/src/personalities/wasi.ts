// WASI preview1 personality (ADR-0004). Maps wasi_snapshot_preview1 imports onto kernel syscalls.
// Preopens follow the wasmtime convention: fd 3 is "/", fd 4 is the working directory.
import {
  AT_FDCWD,
  O_APPEND,
  O_CREAT,
  O_DIRECTORY,
  O_EXCL,
  O_RDONLY,
  O_RDWR,
  O_TRUNC,
  O_WRONLY,
  SEEK_CUR,
} from '../abi/constants.ts'
import type { Dirent, FileType, Stat } from '../abi/constants.ts'
import { Errno } from '../abi/errno.ts'
import type { BootMessage } from '../abi/protocol.ts'
import { SysError, type SyscallClient } from '../process/syscalls.ts'

// WASI errno values.
const SUCCESS = 0
const WASI_EBADF = 8
const WASI_EIO = 29
const WASI_ENOSYS = 52

const LINUX_TO_WASI = new Map<number, number>([
  [Errno.E2BIG, 1],
  [Errno.EACCES, 2],
  [Errno.EAGAIN, 6],
  [Errno.EBADF, 8],
  [Errno.EBUSY, 10],
  [Errno.ECHILD, 12],
  [Errno.EEXIST, 20],
  [Errno.EFAULT, 21],
  [Errno.EFBIG, 22],
  [Errno.EINTR, 27],
  [Errno.EINVAL, 28],
  [Errno.EIO, 29],
  [Errno.EISDIR, 31],
  [Errno.ELOOP, 32],
  [Errno.EMFILE, 33],
  [Errno.ENAMETOOLONG, 37],
  [Errno.ENFILE, 41],
  [Errno.ENODEV, 43],
  [Errno.ENOENT, 44],
  [Errno.ENOEXEC, 45],
  [Errno.ENOMEM, 48],
  [Errno.ENOSPC, 51],
  [Errno.ENOSYS, 52],
  [Errno.ENOTDIR, 54],
  [Errno.ENOTEMPTY, 55],
  [Errno.ENOTTY, 59],
  [Errno.ENXIO, 60],
  [Errno.EOVERFLOW, 61],
  [Errno.EPERM, 63],
  [Errno.EPIPE, 64],
  [Errno.ERANGE, 68],
  [Errno.EROFS, 69],
  [Errno.ESPIPE, 70],
  [Errno.ESRCH, 71],
  [Errno.EXDEV, 75],
])

const FILETYPE: Record<FileType, number> = { chardev: 2, dir: 3, file: 4, fifo: 0 }

const RIGHT_FD_READ = 1n << 1n
const RIGHT_FD_WRITE = 1n << 6n
const ALL_RIGHTS = 0x1fffffffn

const OFLAG_CREAT = 1
const OFLAG_DIRECTORY = 2
const OFLAG_EXCL = 4
const OFLAG_TRUNC = 8
const FDFLAG_APPEND = 1

const CLOCK_REALTIME = 0
const EVENTTYPE_CLOCK = 0

export function runWasi(boot: BootMessage, sys: SyscallClient): never {
  const module = boot.module
  if (!module) throw new Error('missing Wasm module')

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const args = boot.argv.map((arg) => encoder.encode(`${arg}\0`))
  const environ = Object.entries(boot.env).map(([key, value]) => encoder.encode(`${key}=${value}\0`))

  const preopens = new Map<number, Uint8Array>()
  for (const [path, name] of [['/', '/'], ['.', '.']]) {
    try {
      preopens.set(sys.call('open', path, O_RDONLY | O_DIRECTORY, 0, AT_FDCWD), encoder.encode(name))
    } catch {
      // A missing working directory just means no "." preopen.
    }
  }

  let memory: WebAssembly.Memory | undefined
  const view = () => new DataView(memory!.buffer)
  const bytes = () => new Uint8Array(memory!.buffer)
  const readString = (ptr: number, len: number) => decoder.decode(bytes().slice(ptr, ptr + len))
  const directoryListings = new Map<number, Dirent[]>()

  /** Runs a syscall-backed operation, translating errors into WASI errno values. */
  const guard = (fn: () => void): number => {
    try {
      fn()
      return SUCCESS
    } catch (error) {
      if (error instanceof SysError) return LINUX_TO_WASI.get(error.errno) ?? WASI_EIO
      throw error
    }
  }

  const gather = (iovs: number, count: number): Uint8Array => {
    const dv = view()
    const parts: Uint8Array[] = []
    let total = 0
    for (let i = 0; i < count; i++) {
      const ptr = dv.getUint32(iovs + i * 8, true)
      const len = dv.getUint32(iovs + i * 8 + 4, true)
      parts.push(bytes().slice(ptr, ptr + len))
      total += len
    }
    if (parts.length === 1) return parts[0]
    const out = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      out.set(part, offset)
      offset += part.length
    }
    return out
  }

  const scatter = (iovs: number, count: number, data: Uint8Array): void => {
    const dv = view()
    let offset = 0
    for (let i = 0; i < count && offset < data.length; i++) {
      const ptr = dv.getUint32(iovs + i * 8, true)
      const len = dv.getUint32(iovs + i * 8 + 4, true)
      const chunk = data.subarray(offset, offset + len)
      bytes().set(chunk, ptr)
      offset += chunk.length
    }
  }

  const iovecTotal = (iovs: number, count: number): number => {
    const dv = view()
    let total = 0
    for (let i = 0; i < count; i++) total += dv.getUint32(iovs + i * 8 + 4, true)
    return total
  }

  const writeFilestat = (ptr: number, stat: Stat): void => {
    const dv = view()
    const ns = (ms: number) => BigInt(Math.round(ms * 1e6))
    dv.setBigUint64(ptr, 1n, true)
    dv.setBigUint64(ptr + 8, BigInt(stat.ino), true)
    dv.setUint8(ptr + 16, FILETYPE[stat.type])
    dv.setBigUint64(ptr + 24, BigInt(stat.nlink), true)
    dv.setBigUint64(ptr + 32, BigInt(stat.size), true)
    dv.setBigUint64(ptr + 40, ns(stat.atimeMs), true)
    dv.setBigUint64(ptr + 48, ns(stat.mtimeMs), true)
    dv.setBigUint64(ptr + 56, ns(stat.ctimeMs), true)
  }

  const writeSizes = (list: Uint8Array[], countPtr: number, sizePtr: number): number => {
    view().setUint32(countPtr, list.length, true)
    view().setUint32(sizePtr, list.reduce((sum, item) => sum + item.length, 0), true)
    return SUCCESS
  }

  const writeList = (list: Uint8Array[], ptrsPtr: number, bufPtr: number): number => {
    let offset = bufPtr
    list.forEach((item, i) => {
      view().setUint32(ptrsPtr + i * 4, offset, true)
      bytes().set(item, offset)
      offset += item.length
    })
    return SUCCESS
  }

  const nowNs = (clock: number): bigint =>
    clock === CLOCK_REALTIME
      ? BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6))
      : BigInt(Math.round(performance.now() * 1e6))

  const wasi: Record<string, (...args: never[]) => number | void> = {
    args_sizes_get: (countPtr: number, sizePtr: number) => writeSizes(args, countPtr, sizePtr),
    args_get: (ptrsPtr: number, bufPtr: number) => writeList(args, ptrsPtr, bufPtr),
    environ_sizes_get: (countPtr: number, sizePtr: number) => writeSizes(environ, countPtr, sizePtr),
    environ_get: (ptrsPtr: number, bufPtr: number) => writeList(environ, ptrsPtr, bufPtr),

    clock_res_get: (_clock: number, outPtr: number) => {
      view().setBigUint64(outPtr, 1000n, true)
      return SUCCESS
    },
    clock_time_get: (clock: number, _precision: bigint, outPtr: number) => {
      view().setBigUint64(outPtr, nowNs(clock), true)
      return SUCCESS
    },

    random_get: (ptr: number, len: number) => {
      const out = new Uint8Array(len)
      for (let offset = 0; offset < len; offset += 65536) {
        crypto.getRandomValues(out.subarray(offset, Math.min(len, offset + 65536)))
      }
      bytes().set(out, ptr)
      return SUCCESS
    },

    fd_write: (fd: number, iovs: number, count: number, nwrittenPtr: number) =>
      guard(() => view().setUint32(nwrittenPtr, sys.call('write', fd, gather(iovs, count)), true)),

    fd_read: (fd: number, iovs: number, count: number, nreadPtr: number) =>
      guard(() => {
        const data = sys.call('read', fd, Math.min(iovecTotal(iovs, count), sys.maxPayload))
        scatter(iovs, count, data)
        view().setUint32(nreadPtr, data.length, true)
      }),

    fd_close: (fd: number) =>
      guard(() => {
        sys.call('close', fd)
        preopens.delete(fd)
        directoryListings.delete(fd)
      }),

    fd_seek: (fd: number, offset: bigint, whence: number, newOffsetPtr: number) =>
      guard(() => view().setBigUint64(newOffsetPtr, BigInt(sys.call('seek', fd, Number(offset), whence)), true)),

    fd_tell: (fd: number, outPtr: number) =>
      guard(() => view().setBigUint64(outPtr, BigInt(sys.call('seek', fd, 0, SEEK_CUR)), true)),

    fd_fdstat_get: (fd: number, ptr: number) =>
      guard(() => {
        const stat = sys.call('fstat', fd)
        const dv = view()
        dv.setUint8(ptr, FILETYPE[stat.type])
        dv.setUint16(ptr + 2, 0, true)
        dv.setBigUint64(ptr + 8, ALL_RIGHTS, true)
        dv.setBigUint64(ptr + 16, ALL_RIGHTS, true)
      }),
    fd_fdstat_set_flags: () => SUCCESS,
    fd_fdstat_set_rights: () => SUCCESS,

    fd_prestat_get: (fd: number, ptr: number) => {
      const name = preopens.get(fd)
      if (!name) return WASI_EBADF
      view().setUint8(ptr, 0)
      view().setUint32(ptr + 4, name.length, true)
      return SUCCESS
    },
    fd_prestat_dir_name: (fd: number, ptr: number, len: number) => {
      const name = preopens.get(fd)
      if (!name) return WASI_EBADF
      bytes().set(name.subarray(0, len), ptr)
      return SUCCESS
    },

    fd_filestat_get: (fd: number, ptr: number) => guard(() => writeFilestat(ptr, sys.call('fstat', fd))),
    fd_filestat_set_size: (fd: number, size: bigint) => guard(() => sys.call('ftruncate', fd, Number(size))),
    fd_filestat_set_times: () => SUCCESS,
    fd_sync: () => SUCCESS,
    fd_datasync: () => SUCCESS,
    fd_advise: () => SUCCESS,

    fd_readdir: (fd: number, buf: number, bufLen: number, cookie: bigint, bufusedPtr: number) =>
      guard(() => {
        let entries = directoryListings.get(fd)
        if (!entries || cookie === 0n) {
          const self = sys.call('fstat', fd)
          entries = [
            { name: '.', type: 'dir', ino: self.ino },
            { name: '..', type: 'dir', ino: 0 },
            ...sys.call('getdents', fd),
          ]
          directoryListings.set(fd, entries)
        }
        const out = new Uint8Array(bufLen)
        let used = 0
        for (let i = Number(cookie); i < entries.length && used < bufLen; i++) {
          const name = encoder.encode(entries[i].name)
          const record = new Uint8Array(24 + name.length)
          const dv = new DataView(record.buffer)
          dv.setBigUint64(0, BigInt(i + 1), true)
          dv.setBigUint64(8, BigInt(entries[i].ino), true)
          dv.setUint32(16, name.length, true)
          dv.setUint8(20, FILETYPE[entries[i].type])
          record.set(name, 24)
          const n = Math.min(record.length, bufLen - used)
          out.set(record.subarray(0, n), used)
          used += n
        }
        bytes().set(out.subarray(0, used), buf)
        view().setUint32(bufusedPtr, used, true)
      }),

    path_open: (
      dirfd: number,
      _lookupFlags: number,
      pathPtr: number,
      pathLen: number,
      oflags: number,
      rightsBase: bigint,
      _rightsInheriting: bigint,
      fdflags: number,
      fdPtr: number,
    ) =>
      guard(() => {
        const read = (rightsBase & RIGHT_FD_READ) !== 0n
        const write = (rightsBase & RIGHT_FD_WRITE) !== 0n
        let flags = write ? (read ? O_RDWR : O_WRONLY) : O_RDONLY
        if (oflags & OFLAG_CREAT) flags |= O_CREAT
        if (oflags & OFLAG_DIRECTORY) flags = (flags & ~O_RDWR & ~O_WRONLY) | O_DIRECTORY
        if (oflags & OFLAG_EXCL) flags |= O_EXCL
        if (oflags & OFLAG_TRUNC) flags |= O_TRUNC
        if (fdflags & FDFLAG_APPEND) flags |= O_APPEND
        const fd = sys.call('open', readString(pathPtr, pathLen), flags, 0o666, dirfd)
        view().setUint32(fdPtr, fd, true)
      }),

    path_filestat_get: (dirfd: number, _flags: number, pathPtr: number, pathLen: number, ptr: number) =>
      guard(() => writeFilestat(ptr, sys.call('stat', readString(pathPtr, pathLen), dirfd))),
    path_filestat_set_times: () => SUCCESS,
    path_create_directory: (dirfd: number, pathPtr: number, pathLen: number) =>
      guard(() => sys.call('mkdir', readString(pathPtr, pathLen), 0o777, dirfd)),
    path_unlink_file: (dirfd: number, pathPtr: number, pathLen: number) =>
      guard(() => sys.call('unlink', readString(pathPtr, pathLen), dirfd)),
    path_remove_directory: (dirfd: number, pathPtr: number, pathLen: number) =>
      guard(() => sys.call('rmdir', readString(pathPtr, pathLen), dirfd)),
    path_rename: (fromFd: number, fromPtr: number, fromLen: number, toFd: number, toPtr: number, toLen: number) =>
      guard(() => sys.call('rename', readString(fromPtr, fromLen), readString(toPtr, toLen), fromFd, toFd)),

    poll_oneoff: (inPtr: number, outPtr: number, count: number, neventsPtr: number) => {
      // Clock subscriptions sleep; fd subscriptions are reported ready immediately (M0 limitation).
      const dv = view()
      let timeoutNs = Infinity
      for (let i = 0; i < count; i++) {
        const sub = inPtr + i * 48
        if (dv.getUint8(sub + 8) === EVENTTYPE_CLOCK) {
          const clock = dv.getUint32(sub + 16, true)
          let ns = Number(dv.getBigUint64(sub + 24, true))
          if (dv.getUint16(sub + 40, true) & 1) ns -= Number(nowNs(clock))
          timeoutNs = Math.min(timeoutNs, Math.max(0, ns))
        } else {
          timeoutNs = 0
        }
      }
      if (timeoutNs > 0 && Number.isFinite(timeoutNs)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timeoutNs / 1e6)
      }
      for (let i = 0; i < count; i++) {
        const sub = inPtr + i * 48
        const event = outPtr + i * 32
        dv.setBigUint64(event, dv.getBigUint64(sub, true), true)
        dv.setUint16(event + 8, 0, true)
        dv.setUint8(event + 10, dv.getUint8(sub + 8))
      }
      dv.setUint32(neventsPtr, count, true)
      return SUCCESS
    },

    proc_exit: (code: number) => sys.exit(code),
    sched_yield: () => SUCCESS,
  }

  const imports: WebAssembly.Imports = { wasi_snapshot_preview1: {} }
  for (const entry of WebAssembly.Module.imports(module)) {
    if (entry.kind !== 'function') continue
    const namespace = (imports[entry.module] ??= {}) as Record<string, unknown>
    namespace[entry.name] =
      entry.module === 'wasi_snapshot_preview1' && Object.hasOwn(wasi, entry.name) ? wasi[entry.name] : () => WASI_ENOSYS
  }

  const instance = new WebAssembly.Instance(module, imports)
  memory = instance.exports.memory as WebAssembly.Memory | undefined
  const start = instance.exports._start
  if (!memory || typeof start !== 'function') {
    sys.call('write', 2, encoder.encode(`${boot.argv[0]}: not a WASI command (missing memory or _start)\n`))
    return sys.exit(126)
  }

  try {
    ;(start as () => void)()
  } catch (error) {
    if (!(error instanceof WebAssembly.RuntimeError)) throw error
    sys.call('write', 2, encoder.encode(`${boot.argv[0]}: wasm trap: ${error.message}\n`))
    return sys.exit(134)
  }
  return sys.exit(0)
}
