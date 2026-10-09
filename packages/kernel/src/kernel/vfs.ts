// In-memory filesystem. M0 keeps it mutable and path-based; ADR-0007's content-addressed,
// copy-on-write store replaces the storage behind this same interface in M2.
import { kerr } from '../abi/errno.ts'
import { S_IFCHR, S_IFDIR, S_IFREG } from '../abi/constants.ts'
import type { Dirent, Stat } from '../abi/constants.ts'
import { basename, dirname, normalize, segments } from './path.ts'

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
}

export interface DirNode extends NodeBase {
  kind: 'dir'
  children: Map<string, VNode>
}

export interface DevNode extends NodeBase {
  kind: 'dev'
  device: DeviceName
}

export type VNode = FileNode | DirNode | DevNode

const encoder = new TextEncoder()

export class MemFS {
  readonly root: DirNode
  private nextIno = 1

  constructor() {
    this.root = { kind: 'dir', children: new Map(), ...this.base(0o755) }
  }

  lookup(path: string): VNode {
    let node: VNode = this.root
    for (const name of segments(path)) {
      if (node.kind !== 'dir') throw kerr('ENOTDIR', path)
      const child = node.children.get(name)
      if (!child) throw kerr('ENOENT', path)
      node = child
    }
    return node
  }

  /** Like lookup, but returns undefined when the final component is missing. */
  tryLookup(path: string): VNode | undefined {
    if (normalize(path) === '/') return this.root
    const parent = this.parentDir(path)
    return parent.children.get(basename(path))
  }

  createFile(path: string, mode = 0o644): FileNode {
    const node: FileNode = { kind: 'file', data: new Uint8Array(0), size: 0, version: 0, ...this.base(mode) }
    this.link(path, node)
    return node
  }

  mkdir(path: string, mode = 0o755): DirNode {
    const node: DirNode = { kind: 'dir', children: new Map(), ...this.base(mode) }
    this.link(path, node)
    return node
  }

  mkdirp(path: string): DirNode {
    let current = this.root
    for (const name of segments(path)) {
      let next = current.children.get(name)
      if (!next) {
        next = { kind: 'dir', children: new Map(), ...this.base(0o755) }
        current.children.set(name, next)
      }
      if (next.kind !== 'dir') throw kerr('ENOTDIR', path)
      current = next
    }
    return current
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
    const kindBits = node.kind === 'dir' ? S_IFDIR : node.kind === 'dev' ? S_IFCHR : S_IFREG
    return {
      type,
      mode: kindBits | node.mode,
      ino: node.ino,
      nlink: node.kind === 'dir' ? 2 : 1,
      size: node.kind === 'file' ? node.size : node.kind === 'dir' ? 4096 : 0,
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
    node.mtimeMs = node.ctimeMs = Date.now()
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

function typeOf(node: VNode): Dirent['type'] {
  return node.kind === 'dev' ? 'chardev' : node.kind
}
