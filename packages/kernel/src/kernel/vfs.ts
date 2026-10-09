// In-memory filesystem, with the hooks ADR-0007's content-addressed store needs (snapshot.ts):
// nodes cache the hash of what they hold until they change, and file data restored from a
// snapshot is shared with the object store until the first write copies it.
import { Errno, KernelError, kerr } from '../abi/errno.ts'
import { S_IFCHR, S_IFDIR, S_IFLNK, S_IFREG } from '../abi/constants.ts'
import type { Dirent, Stat } from '../abi/constants.ts'
import { basename, dirname, normalize } from './path.ts'

export type DeviceName = 'null'

interface NodeBase {
  ino: number
  mode: number
  atimeMs: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
}

export interface FileNode extends NodeBase {
  kind: 'file'
  data: Uint8Array
  size: number
  /** Bumped on every content change; used for cache invalidation. */
  version: number
  /** Hard links to this file. */
  nlink: number
  /** The blob hash of the contents, until they change. */
  hash?: string
  /** `data` is an object store blob: copied before the first write (copy-on-write). */
  shared?: boolean
}

export interface DirNode extends NodeBase {
  kind: 'dir'
  children: Map<string, VNode>
  /** The tree hash of the listing it had when last hashed, and that listing (snapshot.ts). */
  hash?: string
  tree?: string
}

export interface DevNode extends NodeBase {
  kind: 'dev'
  device: DeviceName
}

export interface SymlinkNode extends NodeBase {
  kind: 'symlink'
  target: string
  /** The blob hash of the target. */
  hash?: string
}

export type VNode = FileNode | DirNode | DevNode | SymlinkNode

// Linux's MAXSYMLINKS.
const MAX_SYMLINKS = 40

const encoder = new TextEncoder()

export class MemFS {
  readonly root: DirNode
  private nextIno = 1

  constructor() {
    this.root = { kind: 'dir', children: new Map(), ...this.base(0o755) }
  }

  /** Finds the node at `path`, following symbolic links (the last one only if `follow`). */
  lookup(path: string, follow = true): VNode {
    return this.walk(path, follow).node
  }

  /** Like lookup, but returns undefined when the final component (or its link target) is missing. */
  tryLookup(path: string, follow = true): VNode | undefined {
    if (normalize(path) === '/') return this.root
    const child = this.parentDir(path).children.get(basename(path))
    if (!child || child.kind !== 'symlink' || !follow) return child
    try {
      return this.lookup(path)
    } catch {
      return undefined
    }
  }

  /** The canonical path of `path`: absolute, with every symbolic link resolved. */
  realpath(path: string): string {
    return this.walk(path, true).path
  }

  createFile(path: string, mode = 0o644): FileNode {
    const node: FileNode = { kind: 'file', data: new Uint8Array(0), size: 0, version: 0, nlink: 1, ...this.base(mode) }
    this.link(path, node)
    return node
  }

  symlink(target: string, path: string): SymlinkNode {
    if (!target) throw kerr('ENOENT', path)
    const node: SymlinkNode = { kind: 'symlink', target, ...this.base(0o777) }
    this.link(path, node)
    return node
  }

  readlink(path: string): string {
    const node = this.lookup(path, false)
    if (node.kind !== 'symlink') throw kerr('EINVAL', path)
    return node.target
  }

  /** A hard link: `to` becomes another name for the file at `from`. */
  hardlink(from: string, to: string): void {
    const node = this.lookup(from, false)
    if (node.kind === 'dir') throw kerr('EPERM', from)
    this.link(to, node)
    if (node.kind === 'file') node.nlink++
  }

  mkdir(path: string, mode = 0o755): DirNode {
    const node: DirNode = { kind: 'dir', children: new Map(), ...this.base(mode) }
    this.link(path, node)
    return node
  }

  mkdirp(path: string): DirNode {
    let existing: VNode | undefined
    try {
      existing = this.lookup(path)
    } catch (error) {
      if (!(error instanceof KernelError) || error.errno !== Errno.ENOENT) throw error
    }
    if (existing) {
      if (existing.kind !== 'dir') throw kerr('ENOTDIR', path)
      return existing
    }
    const parent = this.mkdirp(dirname(path))
    const node: DirNode = { kind: 'dir', children: new Map(), ...this.base(0o755) }
    parent.children.set(basename(path), node)
    this.touch(parent)
    return node
  }

  mknod(path: string, device: DeviceName): DevNode {
    const node: DevNode = { kind: 'dev', device, ...this.base(0o666) }
    this.link(path, node)
    return node
  }

  unlink(path: string): void {
    const parent = this.parentDir(path)
    const name = basename(path)
    const node = parent.children.get(name)
    if (!node) throw kerr('ENOENT', path)
    if (node.kind === 'dir') throw kerr('EISDIR', path)
    parent.children.delete(name)
    if (node.kind === 'file') node.nlink--
    this.touch(parent)
  }

  rmdir(path: string): void {
    if (normalize(path) === '/') throw kerr('EBUSY', path)
    const parent = this.parentDir(path)
    const name = basename(path)
    const node = parent.children.get(name)
    if (!node) throw kerr('ENOENT', path)
    if (node.kind !== 'dir') throw kerr('ENOTDIR', path)
    if (node.children.size) throw kerr('ENOTEMPTY', path)
    parent.children.delete(name)
    this.touch(parent)
  }

  rename(from: string, to: string): void {
    from = normalize(from)
    to = normalize(to)
    if (from === '/' || to === '/') throw kerr('EBUSY')
    if (to.startsWith(`${from}/`)) throw kerr('EINVAL', `${from} -> ${to}`)
    const fromParent = this.parentDir(from)
    const node = fromParent.children.get(basename(from))
    if (!node) throw kerr('ENOENT', from)
    if (from === to) return
    const toParent = this.parentDir(to)
    const existing = toParent.children.get(basename(to))
    if (existing) {
      if (node.kind === 'dir' && existing.kind !== 'dir') throw kerr('ENOTDIR', to)
      if (node.kind !== 'dir' && existing.kind === 'dir') throw kerr('EISDIR', to)
      if (existing.kind === 'dir' && existing.children.size) throw kerr('ENOTEMPTY', to)
      if (existing === node) return
      if (existing.kind === 'file') existing.nlink--
    }
    fromParent.children.delete(basename(from))
    toParent.children.set(basename(to), node)
    this.touch(fromParent)
    this.touch(toParent)
  }

  readdir(dir: DirNode): Dirent[] {
    return [...dir.children.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, node]) => ({ name, type: typeOf(node), ino: node.ino }))
  }

  stat(node: VNode): Stat {
    const type = typeOf(node)
    const kindBits = KIND_BITS[node.kind]
    return {
      type,
      mode: kindBits | node.mode,
      ino: node.ino,
      nlink: node.kind === 'dir' ? 2 : node.kind === 'file' ? node.nlink : 1,
      size: node.kind === 'file' ? node.size : node.kind === 'dir' ? 4096 : node.kind === 'symlink' ? encoder.encode(node.target).length : 0,
      atimeMs: node.atimeMs,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.ctimeMs,
      birthtimeMs: node.birthtimeMs,
    }
  }

  // Convenience helpers for hosts and tests.

  writeFile(path: string, content: Uint8Array | string, mode?: number): FileNode {
    const existing = this.tryLookup(path)
    if (existing && existing.kind !== 'file') throw kerr('EISDIR', path)
    const node = existing ?? this.createFile(path, mode)
    MemFS.truncate(node, 0)
    MemFS.writeAt(node, 0, typeof content === 'string' ? encoder.encode(content) : content)
    if (mode !== undefined) node.mode = mode
    return node
  }

  readFile(path: string): Uint8Array {
    const node = this.lookup(path)
    if (node.kind === 'dir') throw kerr('EISDIR', path)
    if (node.kind !== 'file') return new Uint8Array(0)
    return node.data.slice(0, node.size)
  }

  static readAt(node: FileNode, position: number, length: number): Uint8Array {
    const end = Math.min(node.size, position + length)
    node.atimeMs = Date.now()
    return position >= end ? new Uint8Array(0) : node.data.slice(position, end)
  }

  static writeAt(node: FileNode, position: number, data: Uint8Array): void {
    const end = position + data.length
    if (node.shared) MemFS.unshare(node, end)
    if (end > node.data.length) {
      const grown = new Uint8Array(Math.max(end, node.data.length * 2, 64))
      grown.set(node.data.subarray(0, node.size))
      node.data = grown
    }
    node.data.set(data, position)
    node.size = Math.max(node.size, end)
    MemFS.modified(node)
  }

  static truncate(node: FileNode, length: number): void {
    if (node.shared) MemFS.unshare(node, length)
    if (length < node.size) node.data.fill(0, length, node.size)
    else if (length > node.data.length) {
      const grown = new Uint8Array(length)
      grown.set(node.data.subarray(0, node.size))
      node.data = grown
    }
    node.size = length
    MemFS.modified(node)
  }

  private static modified(node: FileNode): void {
    node.version++
    node.hash = undefined
    node.mtimeMs = node.ctimeMs = Date.now()
  }

  /** Copy-on-write: a file restored from a snapshot gets its own buffer before it changes. */
  private static unshare(node: FileNode, capacity: number): void {
    const own = new Uint8Array(Math.max(capacity, node.size, 64))
    own.set(node.data.subarray(0, node.size))
    node.data = own
    node.shared = false
  }

  /**
   * Puts `node` (a whole tree) at `path` in place of what is there now, as restoring a snapshot
   * does. The parent must exist. Returns the node it replaced.
   */
  replace(path: string, node: VNode): VNode | undefined {
    const parent = this.parentDir(path)
    const name = basename(path)
    const previous = parent.children.get(name)
    parent.children.set(name, node)
    this.touch(parent)
    return previous
  }

  /** A fresh inode number and times, for nodes built outside (snapshot.ts). */
  newNode(mode: number): NodeBase {
    return this.base(mode)
  }

  /**
   * Resolves a path component by component. Symbolic links are expanded in place, and `..` after
   * a link goes to the parent of the link's target, as on Linux.
   */
  private walk(path: string, follow: boolean): { node: VNode; path: string } {
    const pending = rawSegments(path).reverse()
    const nodes: VNode[] = [this.root]
    const names: string[] = []
    let hops = 0
    while (pending.length) {
      const name = pending.pop()!
      const current = nodes[nodes.length - 1]
      if (current.kind !== 'dir') throw kerr('ENOTDIR', path)
      if (name === '..') {
        if (names.length) {
          names.pop()
          nodes.pop()
        }
        continue
      }
      const child = current.children.get(name)
      if (!child) throw kerr('ENOENT', path)
      if (child.kind === 'symlink' && (pending.length || follow)) {
        if (++hops > MAX_SYMLINKS) throw kerr('ELOOP', path)
        if (child.target.startsWith('/')) {
          nodes.length = 1
          names.length = 0
        }
        for (const part of rawSegments(child.target).reverse()) pending.push(part)
        continue
      }
      nodes.push(child)
      names.push(name)
    }
    return { node: nodes[nodes.length - 1], path: `/${names.join('/')}` }
  }

  private parentDir(path: string): DirNode {
    if (normalize(path) === '/') throw kerr('EEXIST', path)
    const parent = this.lookup(dirname(path))
    if (parent.kind !== 'dir') throw kerr('ENOTDIR', path)
    return parent
  }

  private link(path: string, node: VNode): void {
    const parent = this.parentDir(path)
    const name = basename(path)
    if (parent.children.has(name)) throw kerr('EEXIST', path)
    parent.children.set(name, node)
    this.touch(parent)
  }

  private touch(node: NodeBase): void {
    node.mtimeMs = node.ctimeMs = Date.now()
  }

  private base(mode: number): NodeBase {
    const now = Date.now()
    return { ino: this.nextIno++, mode, atimeMs: now, mtimeMs: now, ctimeMs: now, birthtimeMs: now }
  }
}

const KIND_BITS: Record<VNode['kind'], number> = { file: S_IFREG, dir: S_IFDIR, dev: S_IFCHR, symlink: S_IFLNK }

function typeOf(node: VNode): Dirent['type'] {
  return node.kind === 'dev' ? 'chardev' : node.kind
}

function rawSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment && segment !== '.')
}
