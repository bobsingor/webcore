// Open file descriptions. Several fds (in one or many processes) can share one description; it is
// released when the last reference closes.
import { kerr } from '../abi/errno.ts'
import {
  O_ACCMODE,
  O_APPEND,
  O_RDONLY,
  O_WRONLY,
  S_IFCHR,
  S_IFIFO,
  SEEK_CUR,
  SEEK_END,
  SEEK_SET,
} from '../abi/constants.ts'
import type { Dirent, FileType, Stat } from '../abi/constants.ts'
import { MemFS } from './vfs.ts'
import type { DeviceName, DirNode, FileNode } from './vfs.ts'
import type { Pipe } from './pipe.ts'

const EMPTY = new Uint8Array(0)

/** What poll reports for an open file. */
export interface Readiness {
  /** A read would return without waiting (data, end of file, or an error). */
  read: boolean
  /** A write would proceed without waiting. */
  write: boolean
  /** The other end is gone. */
  hangup: boolean
  /** Bytes a read can take now. */
  bytes: number
}

export abstract class OpenFile {
  abstract readonly type: FileType
  readonly flags: number
  private refs = 1

  constructor(flags: number) {
    this.flags = flags
  }

  get readable(): boolean {
    return (this.flags & O_ACCMODE) !== O_WRONLY
  }

  get writable(): boolean {
    return (this.flags & O_ACCMODE) !== O_RDONLY
  }

  read(_max: number, _signal?: AbortSignal): Uint8Array | Promise<Uint8Array> {
    throw kerr('EBADF')
  }

  write(_data: Uint8Array, _signal?: AbortSignal): number | Promise<number> {
    throw kerr('EBADF')
  }

  seek(_offset: number, _whence: number): number {
    throw kerr('ESPIPE')
  }

  truncate(_length: number): void {
    throw kerr('EINVAL')
  }

  getdents(): Dirent[] {
    throw kerr('ENOTDIR')
  }

  abstract stat(): Stat

  /** For poll. Files and devices never make a reader or writer wait. */
  readiness(): Readiness {
    return { read: this.readable, write: this.writable, hangup: false, bytes: 0 }
  }

  /** Calls `listener` whenever readiness may have changed; returns what stops it. */
  watchReadiness(_listener: () => void): () => void {
    return () => {}
  }

  retain(): this {
    this.refs++
    return this
  }

  release(): void {
    if (--this.refs === 0) this.closed()
  }

  protected closed(): void {}
}

export class FileHandle extends OpenFile {
  readonly type = 'file'
  readonly path: string
  readonly node: FileNode
  private readonly fs: MemFS
  private readonly onDirtyClose?: (path: string) => void
  private position = 0
  private dirty = false

  constructor(fs: MemFS, node: FileNode, path: string, flags: number, onDirtyClose?: (path: string) => void) {
    super(flags)
    this.fs = fs
    this.node = node
    this.path = path
    this.onDirtyClose = onDirtyClose
  }

  override read(max: number): Uint8Array {
    if (!this.readable) throw kerr('EBADF')
    const data = MemFS.readAt(this.node, this.position, max)
    this.position += data.length
    return data
  }

  override write(data: Uint8Array): number {
    if (!this.writable) throw kerr('EBADF')
    if (this.flags & O_APPEND) this.position = this.node.size
    MemFS.writeAt(this.node, this.position, data)
    this.position += data.length
    this.dirty = true
    return data.length
  }

  override seek(offset: number, whence: number): number {
    const base =
      whence === SEEK_SET ? 0 : whence === SEEK_CUR ? this.position : whence === SEEK_END ? this.node.size : NaN
    const next = base + offset
    if (!Number.isFinite(next) || next < 0) throw kerr('EINVAL')
    this.position = next
    return next
  }

  override truncate(length: number): void {
    if (!this.writable || length < 0) throw kerr('EINVAL')
    MemFS.truncate(this.node, length)
    this.dirty = true
  }

  /** Marks the file as modified (e.g. by O_TRUNC at open). */
  markDirty(): void {
    this.dirty = true
  }

  stat(): Stat {
    return this.fs.stat(this.node)
  }

  protected override closed(): void {
    if (this.dirty) this.onDirtyClose?.(this.path)
  }
}

export class DirHandle extends OpenFile {
  readonly type = 'dir'
  readonly path: string
  readonly node: DirNode
  private readonly fs: MemFS

  constructor(fs: MemFS, node: DirNode, path: string, flags: number) {
    super(flags)
    this.fs = fs
    this.node = node
    this.path = path
  }

  override read(): Uint8Array {
    throw kerr('EISDIR')
  }

  override getdents(): Dirent[] {
    return this.fs.readdir(this.node)
  }

  stat(): Stat {
    return this.fs.stat(this.node)
  }
}

export class DeviceHandle extends OpenFile {
  readonly type = 'chardev'
  readonly device: DeviceName

  constructor(device: DeviceName, flags: number) {
    super(flags)
    this.device = device
  }

  override read(): Uint8Array {
    return EMPTY
  }

  override write(data: Uint8Array): number {
    return data.length
  }

  stat(): Stat {
    return pseudoStat('chardev', S_IFCHR | 0o666, 0)
  }
}

export class PipeReader extends OpenFile {
  readonly type = 'fifo'
  private readonly pipe: Pipe

  constructor(pipe: Pipe) {
    super(O_RDONLY)
    this.pipe = pipe
  }

  override read(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.pipe.read(max, signal)
  }

  stat(): Stat {
    return pseudoStat('fifo', S_IFIFO | 0o600, this.pipe.size)
  }

  override readiness(): Readiness {
    return { read: this.pipe.size > 0 || this.pipe.writeClosed, write: false, hangup: this.pipe.writeClosed, bytes: this.pipe.size }
  }

  override watchReadiness(listener: () => void): () => void {
    return this.pipe.watch(listener)
  }

  protected override closed(): void {
    this.pipe.closeRead()
  }
}

export class PipeWriter extends OpenFile {
  readonly type = 'fifo'
  private readonly pipe: Pipe

  constructor(pipe: Pipe) {
    super(O_WRONLY)
    this.pipe = pipe
  }

  override write(data: Uint8Array, signal?: AbortSignal): Promise<number> {
    return this.pipe.write(data, signal)
  }

  stat(): Stat {
    return pseudoStat('fifo', S_IFIFO | 0o600, this.pipe.size)
  }

  override readiness(): Readiness {
    const hangup = this.pipe.readClosed
    return { read: false, write: hangup || this.pipe.size < this.pipe.capacity, hangup, bytes: 0 }
  }

  override watchReadiness(listener: () => void): () => void {
    return this.pipe.watch(listener)
  }

  protected override closed(): void {
    this.pipe.closeWrite()
  }
}

export function pseudoStat(type: FileType, mode: number, size: number): Stat {
  const now = Date.now()
  return { type, mode, ino: 0, nlink: 1, size, atimeMs: now, mtimeMs: now, ctimeMs: now, birthtimeMs: now }
}
