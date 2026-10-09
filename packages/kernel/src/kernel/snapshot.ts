// Snapshots (ADR-0007). A directory becomes a tree object, a JSON listing of
// [name, kind, mode, hash] sorted by name; files and link targets become blobs. Hashing is
// deferred and incremental: nodes cache their hash until they change, and a directory whose
// listing is unchanged keeps its tree hash without rehashing. Restoring builds nodes over the
// stored objects without copying them; files copy their data on the first write (vfs.ts).
import { kerr } from '../abi/errno.ts'
import { hashBytes, type ObjectStore } from './store.ts'
import type { DirNode, FileNode, MemFS, SymlinkNode, VNode } from './vfs.ts'
import type { FsOp } from './events.ts'

type Kind = 'f' | 'd' | 'l'
type Entry = [name: string, kind: Kind, mode: number, hash: string]

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Hashes `dir` into the store; returns its tree hash. Devices aren't part of snapshots. */
export async function snapshotTree(store: ObjectStore, dir: DirNode): Promise<string> {
  const children = [...dir.children].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const hashes = await Promise.all(children.map(([, node]) => hashNode(store, node)))
  const entries: Entry[] = []
  children.forEach(([name, node], i) => {
    const hash = hashes[i]
    if (hash) entries.push([name, kindOf(node), node.mode & 0o7777, hash])
  })
  const tree = JSON.stringify(entries)
  if (dir.hash && dir.tree === tree && store.has(dir.hash)) return dir.hash
  const hash = await putObject(store, encoder.encode(tree))
  dir.hash = hash
  dir.tree = tree
  return hash
}

async function hashNode(store: ObjectStore, node: VNode): Promise<string | undefined> {
  switch (node.kind) {
    case 'dir':
      return snapshotTree(store, node)
    case 'symlink':
      return (node.hash ??= await putObject(store, encoder.encode(node.target)))
    case 'file': {
      if (node.hash && store.has(node.hash)) return node.hash
      const version = node.version
      const bytes = node.data.slice(0, node.size)
      const hash = await putObject(store, bytes)
      // Unless it changed meanwhile, the file now shares the stored copy instead of keeping its own.
      if (node.version === version) {
        node.hash = hash
        node.data = store.get(hash)!
        node.shared = true
      }
      return hash
    }
    default:
      return undefined
  }
}

async function putObject(store: ObjectStore, bytes: Uint8Array): Promise<string> {
  const hash = await hashBytes(bytes)
  if (!store.has(hash)) store.put(hash, bytes)
  return hash
}

function kindOf(node: VNode): Kind {
  return node.kind === 'dir' ? 'd' : node.kind === 'symlink' ? 'l' : 'f'
}

function object(store: ObjectStore, hash: string): Uint8Array {
  const bytes = store.get(hash)
  if (!bytes) throw kerr('EIO', `missing object ${hash}`)
  return bytes
}

export function readTree(store: ObjectStore, hash: string): Entry[] {
  return JSON.parse(decoder.decode(object(store, hash))) as Entry[]
}

/** Builds the tree `hash` as new nodes over the stored objects (copy-on-write). */
export function materialize(fs: MemFS, store: ObjectStore, hash: string, mode = 0o755): DirNode {
  const bytes = object(store, hash)
  const tree = decoder.decode(bytes)
  const dir: DirNode = { kind: 'dir', children: new Map(), ...fs.newNode(mode), hash, tree }
  for (const [name, kind, childMode, child] of JSON.parse(tree) as Entry[]) {
    if (kind === 'd') dir.children.set(name, materialize(fs, store, child, childMode))
    else if (kind === 'l') {
      const link: SymlinkNode = { kind: 'symlink', target: decoder.decode(object(store, child)), hash: child, ...fs.newNode(childMode) }
      dir.children.set(name, link)
    } else {
      const data = object(store, child)
      const file: FileNode = { kind: 'file', data, size: data.length, shared: true, hash: child, version: 0, nlink: 1, ...fs.newNode(childMode) }
      dir.children.set(name, file)
    }
  }
  return dir
}

/**
 * The changes from tree `before` to tree `after` under `path`, as fs.change events would report
 * them: only subtrees whose hashes differ are compared.
 */
export function diffTrees(
  store: ObjectStore,
  before: string | undefined,
  after: string | undefined,
  path: string,
  emit: (op: FsOp, path: string) => void,
): void {
  if (before === after) return
  const left = new Map((before ? readTree(store, before) : []).map((entry) => [entry[0], entry]))
  const right = new Map((after ? readTree(store, after) : []).map((entry) => [entry[0], entry]))
  const removed = (entry: Entry, at: string) => {
    if (entry[1] === 'd') {
      diffTrees(store, entry[3], undefined, at, emit)
      emit('rmdir', at)
    } else emit('unlink', at)
  }
  const added = (entry: Entry, at: string) => {
    if (entry[1] === 'd') {
      emit('mkdir', at)
      diffTrees(store, undefined, entry[3], at, emit)
    } else emit('create', at)
  }
  for (const [name, entry] of left) {
    const at = `${path}/${name}`
    const next = right.get(name)
    if (!next) removed(entry, at)
    else if (entry[3] !== next[3] || entry[1] !== next[1] || entry[2] !== next[2]) {
      if (entry[1] === 'd' && next[1] === 'd') diffTrees(store, entry[3], next[3], at, emit)
      else if (entry[1] !== next[1]) {
        removed(entry, at)
        added(next, at)
      } else emit('write', at)
    }
  }
  for (const [name, entry] of right) if (!left.has(name)) added(entry, `${path}/${name}`)
}

/** Every object `roots` reach: what a store must keep for them. */
export function reachable(store: ObjectStore, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>()
  const visit = (hash: string) => {
    if (seen.has(hash)) return
    seen.add(hash)
    for (const [, kind, , child] of readTree(store, hash)) {
      if (kind === 'd') visit(child)
      else seen.add(child)
    }
  }
  for (const root of roots) if (store.has(root)) visit(root)
  return seen
}
