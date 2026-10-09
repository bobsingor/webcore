// Node's `fs` module over kernel syscalls (M0 subset). Sync calls block on the syscall page;
// `fs.promises.readFile`/`writeFile` use async syscalls so the event loop keeps running.
import {
  O_APPEND,
  O_CREAT,
  O_DIRECTORY,
  O_EXCL,
  O_RDONLY,
  O_RDWR,
  O_TRUNC,
  O_WRONLY,
  SEEK_CUR,
  SEEK_SET,
} from '../../abi/constants.ts'
import type { Dirent as KernelDirent, FileType, Stat } from '../../abi/constants.ts'
import { Errno } from '../../abi/errno.ts'
import { SysError, type SyscallClient } from '../../process/syscalls.ts'
import { Buffer } from './buffer.ts'
import { systemError } from './errors.ts'
import type { EventLoop } from './loop.ts'
import type { NodePath } from './path.ts'

type PathLike = string | URL | Uint8Array
type EncodingOption = { encoding?: string | null; flag?: string; mode?: number } | string | null | undefined
type Data = string | Uint8Array

const FLAGS: Record<string, number> = {
  r: O_RDONLY,
  'r+': O_RDWR,
  w: O_WRONLY | O_CREAT | O_TRUNC,
  wx: O_WRONLY | O_CREAT | O_TRUNC | O_EXCL,
  'w+': O_RDWR | O_CREAT | O_TRUNC,
  'wx+': O_RDWR | O_CREAT | O_TRUNC | O_EXCL,
  a: O_WRONLY | O_CREAT | O_APPEND,
  ax: O_WRONLY | O_CREAT | O_APPEND | O_EXCL,
  'a+': O_RDWR | O_CREAT | O_APPEND,
  'ax+': O_RDWR | O_CREAT | O_APPEND | O_EXCL,
}

const COPYFILE_EXCL = 1

class TypedEntry {
  protected readonly kind: FileType

  constructor(kind: FileType) {
    this.kind = kind
  }

  isFile(): boolean {
    return this.kind === 'file'
  }

  isDirectory(): boolean {
    return this.kind === 'dir'
  }

  isFIFO(): boolean {
    return this.kind === 'fifo'
  }

  isCharacterDevice(): boolean {
    return this.kind === 'chardev'
  }

  isSymbolicLink(): boolean {
    return false
  }

  isBlockDevice(): boolean {
    return false
  }

  isSocket(): boolean {
    return false
  }
}

export class Stats extends TypedEntry {
  dev = 1
  uid = 1000
  gid = 1000
  rdev = 0
  blksize = 4096
  ino: number
  mode: number
  nlink: number
  size: number
  blocks: number
  atimeMs: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  atime: Date
  mtime: Date
  ctime: Date
  birthtime: Date

  constructor(stat: Stat) {
    super(stat.type)
    this.ino = stat.ino
    this.mode = stat.mode
    this.nlink = stat.nlink
    this.size = stat.size
    this.blocks = Math.ceil(stat.size / 512)
    this.atimeMs = stat.atimeMs
    this.mtimeMs = stat.mtimeMs
    this.ctimeMs = stat.ctimeMs
    this.birthtimeMs = stat.birthtimeMs
    this.atime = new Date(stat.atimeMs)
    this.mtime = new Date(stat.mtimeMs)
    this.ctime = new Date(stat.ctimeMs)
    this.birthtime = new Date(stat.birthtimeMs)
  }
}

export class Dirent extends TypedEntry {
  name: string
  parentPath: string
  path: string

  constructor(entry: KernelDirent, parentPath: string) {
    super(entry.type)
    this.name = entry.name
    this.parentPath = parentPath
    this.path = parentPath
  }
}

export function createFs(sys: SyscallClient, loop: EventLoop, path: NodePath) {
  const toPath = (file: PathLike): string => {
    if (typeof file === 'string') return file
    if (file instanceof URL) {
      if (file.protocol !== 'file:') throw new TypeError('The URL must be of scheme file')
      return decodeURIComponent(file.pathname)
    }
    if (file instanceof Uint8Array) return Buffer.wrap(file).toString()
    throw new TypeError(
      `The "path" argument must be of type string or an instance of Buffer or URL. Received ${typeof file}`,
    )
  }

  const parseFlags = (flag: string | number = 'r'): number => {
    if (typeof flag === 'number') return flag
    const flags = FLAGS[flag]
    if (flags === undefined) throw new TypeError(`The value "${flag}" is invalid for option "flags"`)
    return flags
  }

  const encodingOf = (options: EncodingOption): string | null | undefined =>
    typeof options === 'string' ? options : options?.encoding

  const optionOf = <K extends 'flag' | 'mode'>(options: EncodingOption, key: K) =>
    typeof options === 'object' && options !== null ? options[key] : undefined

  const toBytes = (data: Data, encoding?: string | null): Uint8Array =>
    typeof data === 'string' ? Buffer.from(data, encoding ?? 'utf8') : data

  /** Runs a syscall-backed operation, converting kernel errors into Node errors. */
  function attempt<T>(syscall: string, target: string | undefined, fn: () => T, dest?: string): T {
    try {
      return fn()
    } catch (error) {
      throw systemError(error, syscall, target, dest)
    }
  }

  function readAll(fd: number): Buffer {
    const chunks: Uint8Array[] = []
    for (;;) {
      const chunk = sys.call('read', fd, sys.maxPayload)
      if (!chunk.length) return Buffer.concat(chunks)
      chunks.push(chunk)
    }
  }

  const fs = {
    constants: {
      F_OK: 0,
      R_OK: 4,
      W_OK: 2,
      X_OK: 1,
      O_RDONLY,
      O_WRONLY,
      O_RDWR,
      O_CREAT,
      O_EXCL,
      O_TRUNC,
      O_APPEND,
      O_DIRECTORY,
      COPYFILE_EXCL,
    },
    Stats,
    Dirent,

    openSync(file: PathLike, flags?: string | number, mode = 0o666): number {
      const target = toPath(file)
      return attempt('open', target, () => sys.call('open', target, parseFlags(flags), mode))
    },

    closeSync(fd: number): void {
      attempt('close', undefined, () => sys.call('close', fd))
    },

    readSync(
      fd: number,
      buffer: Uint8Array,
      offsetOrOptions?: number | { offset?: number; length?: number; position?: number | null },
      length?: number,
      position?: number | null,
    ): number {
      let offset = 0
      if (typeof offsetOrOptions === 'object' && offsetOrOptions !== null) {
        offset = offsetOrOptions.offset ?? 0
        length = offsetOrOptions.length
        position = offsetOrOptions.position
      } else {
        offset = offsetOrOptions ?? 0
      }
      const max = Math.min(length ?? buffer.length - offset, sys.maxPayload)
      return attempt('read', undefined, () => {
        const positioned = typeof position === 'number' && position >= 0
        const restore = positioned ? sys.call('seek', fd, 0, SEEK_CUR) : 0
        if (positioned) sys.call('seek', fd, position as number, SEEK_SET)
        const data = sys.call('read', fd, max)
        if (positioned) sys.call('seek', fd, restore, SEEK_SET)
        buffer.set(data, offset)
        return data.length
      })
    },

    writeSync(fd: number, data: Data, offsetOrPosition?: number, lengthOrEncoding?: number | string): number {
      const bytes =
        typeof data === 'string'
          ? Buffer.from(data, typeof lengthOrEncoding === 'string' ? lengthOrEncoding : 'utf8')
          : data.subarray(
              offsetOrPosition ?? 0,
              typeof lengthOrEncoding === 'number' ? (offsetOrPosition ?? 0) + lengthOrEncoding : undefined,
            )
      return attempt('write', undefined, () => sys.call('write', fd, bytes))
    },

    readFileSync(file: PathLike | number, options?: EncodingOption): string | Buffer {
      const encoding = encodingOf(options)
      let data: Buffer
      if (typeof file === 'number') {
        data = attempt('read', undefined, () => readAll(file))
      } else {
        const target = toPath(file)
        const fd = fs.openSync(target, optionOf(options, 'flag') ?? 'r')
        try {
          data = attempt('read', target, () => readAll(fd))
        } finally {
          fs.closeSync(fd)
        }
      }
      return encoding ? data.toString(encoding) : data
    },

    writeFileSync(file: PathLike | number, data: Data, options?: EncodingOption): void {
      const bytes = toBytes(data, encodingOf(options))
      if (typeof file === 'number') {
        attempt('write', undefined, () => sys.call('write', file, bytes))
        return
      }
      const target = toPath(file)
      const fd = fs.openSync(target, optionOf(options, 'flag') ?? 'w', optionOf(options, 'mode') ?? 0o666)
      try {
        attempt('write', target, () => sys.call('write', fd, bytes))
      } finally {
        fs.closeSync(fd)
      }
    },

    appendFileSync(file: PathLike | number, data: Data, options?: EncodingOption): void {
      const encoding = encodingOf(options)
      fs.writeFileSync(file, data, { encoding, flag: optionOf(options, 'flag') ?? 'a' })
    },

    existsSync(file: PathLike): boolean {
      try {
        sys.call('stat', toPath(file))
        return true
      } catch {
        return false
      }
    },

    statSync(file: PathLike, options?: { throwIfNoEntry?: boolean }): Stats | undefined {
      const target = toPath(file)
      try {
        return new Stats(sys.call('stat', target))
      } catch (error) {
        if (options?.throwIfNoEntry === false && error instanceof SysError && error.errno === Errno.ENOENT) {
          return undefined
        }
        throw systemError(error, 'stat', target)
      }
    },

    lstatSync(file: PathLike, options?: { throwIfNoEntry?: boolean }): Stats | undefined {
      return fs.statSync(file, options)
    },

    fstatSync(fd: number): Stats {
      return new Stats(attempt('fstat', undefined, () => sys.call('fstat', fd)))
    },

    readdirSync(dir: PathLike, options?: EncodingOption | { withFileTypes?: boolean }): (string | Dirent)[] {
      const target = toPath(dir)
      const entries = attempt('scandir', target, () => {
        const fd = sys.call('open', target, O_RDONLY | O_DIRECTORY)
        try {
          return sys.call('getdents', fd)
        } finally {
          sys.call('close', fd)
        }
      })
      const withFileTypes = typeof options === 'object' && options !== null && 'withFileTypes' in options
      return withFileTypes && options.withFileTypes
        ? entries.map((entry) => new Dirent(entry, target))
        : entries.map((entry) => entry.name)
    },

    mkdirSync(dir: PathLike, options?: number | { recursive?: boolean; mode?: number }): string | undefined {
      const target = path.resolve(toPath(dir))
      const mode = typeof options === 'number' ? options : (options?.mode ?? 0o777)
      if (typeof options !== 'object' || !options.recursive) {
        attempt('mkdir', target, () => sys.call('mkdir', target, mode))
        return undefined
      }
      let first: string | undefined
      let current = ''
      for (const part of target.split('/').filter(Boolean)) {
        current += `/${part}`
        try {
          sys.call('mkdir', current, mode)
          first ??= current
        } catch (error) {
          if (!(error instanceof SysError && error.errno === Errno.EEXIST)) throw systemError(error, 'mkdir', target)
          if (sys.call('stat', current).type !== 'dir') {
            throw systemError(new SysError(Errno.ENOTDIR, 'mkdir'), 'mkdir', target)
          }
        }
      }
      return first
    },

    rmdirSync(dir: PathLike): void {
      const target = toPath(dir)
      attempt('rmdir', target, () => sys.call('rmdir', target))
    },

    unlinkSync(file: PathLike): void {
      const target = toPath(file)
      attempt('unlink', target, () => sys.call('unlink', target))
    },

    renameSync(from: PathLike, to: PathLike): void {
      const source = toPath(from)
      const target = toPath(to)
      attempt('rename', source, () => sys.call('rename', source, target), target)
    },

    rmSync(file: PathLike, options?: { recursive?: boolean; force?: boolean }): void {
      const target = toPath(file)
      let stat: Stat
      try {
        stat = sys.call('stat', target)
      } catch (error) {
        if (options?.force && error instanceof SysError && error.errno === Errno.ENOENT) return
        throw systemError(error, 'rm', target)
      }
      if (stat.type !== 'dir') {
        attempt('rm', target, () => sys.call('unlink', target))
        return
      }
      if (!options?.recursive) throw systemError(new SysError(Errno.EISDIR, 'rm'), 'rm', target)
      for (const name of fs.readdirSync(target) as string[]) fs.rmSync(`${target}/${name}`, options)
      attempt('rm', target, () => sys.call('rmdir', target))
    },

    copyFileSync(from: PathLike, to: PathLike, mode = 0): void {
      if (mode & COPYFILE_EXCL && fs.existsSync(to)) {
        throw systemError(new SysError(Errno.EEXIST, 'copyfile'), 'copyfile', toPath(from), toPath(to))
      }
      fs.writeFileSync(to, fs.readFileSync(from) as Buffer)
    },

    accessSync(file: PathLike, _mode?: number): void {
      const target = toPath(file)
      attempt('access', target, () => sys.call('stat', target))
    },

    realpathSync(file: PathLike): string {
      const target = path.resolve(toPath(file))
      fs.accessSync(target)
      return target
    },

    mkdtempSync(prefix: string): string {
      for (;;) {
        const candidate = `${prefix}${Math.random().toString(36).slice(2, 8)}`
        try {
          sys.call('mkdir', candidate, 0o700)
          return candidate
        } catch (error) {
          if (!(error instanceof SysError && error.errno === Errno.EEXIST)) throw systemError(error, 'mkdtemp', prefix)
        }
      }
    },

    ftruncateSync(fd: number, length = 0): void {
      attempt('ftruncate', undefined, () => sys.call('ftruncate', fd, length))
    },

    truncateSync(file: PathLike, length = 0): void {
      const fd = fs.openSync(file, 'r+')
      try {
        fs.ftruncateSync(fd, length)
      } finally {
        fs.closeSync(fd)
      }
    },
  }

  // Async file I/O over async syscalls.
  async function readFileAsync(file: PathLike, options?: EncodingOption): Promise<string | Buffer> {
    const target = toPath(file)
    const flags = parseFlags(optionOf(options, 'flag') ?? 'r')
    const fd = await sys.callAsync('open', target, flags, 0o666).catch((error) => {
      throw systemError(error, 'open', target)
    })
    try {
      const chunks: Uint8Array[] = []
      for (;;) {
        const chunk = await sys.callAsync('read', fd, sys.maxPayload)
        if (!chunk.length) break
        chunks.push(chunk)
      }
      const data = Buffer.concat(chunks)
      const encoding = encodingOf(options)
      return encoding ? data.toString(encoding) : data
    } finally {
      await sys.callAsync('close', fd)
    }
  }

  async function writeFileAsync(file: PathLike, data: Data, options?: EncodingOption): Promise<void> {
    const target = toPath(file)
    const flags = parseFlags(optionOf(options, 'flag') ?? 'w')
    const fd = await sys.callAsync('open', target, flags, optionOf(options, 'mode') ?? 0o666).catch((error) => {
      throw systemError(error, 'open', target)
    })
    try {
      await sys.callAsync('write', fd, toBytes(data, encodingOf(options)))
    } finally {
      await sys.callAsync('close', fd)
    }
  }

  // Metadata operations are fast and local, so their async forms reuse the sync implementations.
  const deferred =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    async (...args: A): Promise<R> =>
      fn(...args)

  const promises = {
    readFile: (file: PathLike, options?: EncodingOption) => loop.track(readFileAsync(file, options)),
    writeFile: (file: PathLike, data: Data, options?: EncodingOption) => loop.track(writeFileAsync(file, data, options)),
    appendFile: deferred(fs.appendFileSync),
    readdir: deferred(fs.readdirSync),
    stat: deferred(fs.statSync),
    lstat: deferred(fs.lstatSync),
    mkdir: deferred(fs.mkdirSync),
    rm: deferred(fs.rmSync),
    rmdir: deferred(fs.rmdirSync),
    unlink: deferred(fs.unlinkSync),
    rename: deferred(fs.renameSync),
    copyFile: deferred(fs.copyFileSync),
    access: deferred(fs.accessSync),
    realpath: deferred(fs.realpathSync),
    mkdtemp: deferred(fs.mkdtempSync),
  }

  const callbackify =
    (fn: (...args: any[]) => Promise<unknown>) =>
    (...args: unknown[]): void => {
      const callback = args.pop()
      if (typeof callback !== 'function') throw new TypeError('The "cb" argument must be of type function')
      loop.track(Promise.resolve().then(() => fn(...args))).then(
        (result) => callback(null, result),
        (error) => callback(error),
      )
    }

  return {
    ...fs,
    promises,
    readFile: callbackify(promises.readFile),
    writeFile: callbackify(promises.writeFile),
    appendFile: callbackify(promises.appendFile),
    readdir: callbackify(promises.readdir),
    stat: callbackify(promises.stat),
    lstat: callbackify(promises.lstat),
    mkdir: callbackify(promises.mkdir),
    rm: callbackify(promises.rm),
    rmdir: callbackify(promises.rmdir),
    unlink: callbackify(promises.unlink),
    rename: callbackify(promises.rename),
    copyFile: callbackify(promises.copyFile),
    access: callbackify(promises.access),
    realpath: callbackify(promises.realpath),
    exists: (file: PathLike, callback: (exists: boolean) => void) => {
      const exists = fs.existsSync(file)
      loop.track(Promise.resolve()).then(() => callback(exists))
    },
  }
}
