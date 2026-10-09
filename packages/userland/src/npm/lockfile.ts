// package-lock.json, lockfileVersion 3: the `packages` map keyed by install path. Reading it skips
// resolution entirely when it still satisfies package.json.
import type { Manifest } from './registry.ts'
import { accepts, edgesOf, markFlags, Node } from './tree.ts'

interface LockEntry {
  name?: string
  version?: string
  resolved?: string
  integrity?: string
  dev?: boolean
  optional?: boolean
  peer?: boolean
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  bin?: string | Record<string, string>
  engines?: Record<string, string>
  os?: string[]
  cpu?: string[]
  libc?: string[]
  license?: string
  deprecated?: string
  hasInstallScript?: boolean
}

export interface Lockfile {
  name?: string
  version?: string
  lockfileVersion: number
  requires?: boolean
  packages: Record<string, LockEntry>
}

const MANIFEST_FIELDS = [
  'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bin', 'engines', 'os', 'cpu', 'libc',
  'license', 'deprecated', 'hasInstallScript',
] as const

/** Rebuilds the tree a lockfile describes, or undefined if it no longer satisfies package.json. */
export function treeFromLockfile(lock: Lockfile, manifest: Manifest): Node | undefined {
  if (!lock || typeof lock.packages !== 'object' || (lock.lockfileVersion ?? 0) < 2) return undefined
  const root = new Node(manifest.name ?? '', manifest.version ?? '', manifest, null, edgesOf(manifest, true))
  const byPath = new Map<string, Node>([['', root]])
  // Parents before children: shorter paths first.
  const paths = Object.keys(lock.packages)
    .filter((path) => path.startsWith('node_modules/'))
    .sort((a, b) => a.split('/node_modules/').length - b.split('/node_modules/').length || (a < b ? -1 : 1))
  for (const path of paths) {
    const entry = lock.packages[path]
    const at = path.lastIndexOf('/node_modules/')
    const parentPath = at < 0 ? '' : path.slice(0, at)
    const name = path.slice(at < 0 ? 'node_modules/'.length : at + '/node_modules/'.length)
    const parent = byPath.get(parentPath)
    if (!parent || !entry.version) return undefined
    const lockManifest: Manifest = { name: entry.name ?? name, version: entry.version }
    for (const field of MANIFEST_FIELDS) if (entry[field] !== undefined) (lockManifest as unknown as Record<string, unknown>)[field] = entry[field]
    let node: Node
    try {
      node = new Node(name, entry.version, lockManifest, parent, edgesOf(lockManifest))
    } catch {
      return undefined
    }
    node.resolved = entry.resolved
    node.integrity = entry.integrity
    parent.children.set(name, node)
    byPath.set(path, node)
  }
  // Every dependency must still resolve to something it accepts; otherwise, resolve afresh.
  for (const node of [root, ...root.descendants()]) {
    for (const dependency of node.edges) {
      const target = node.resolve(dependency.name)
      if (!target) {
        if (dependency.type === 'optional' || (dependency.type === 'peer' && node.parent)) continue
        return undefined
      }
      if (!accepts(dependency, target)) return undefined
    }
  }
  // Entries nothing depends on any more (after an uninstall) are extraneous.
  const used = new Set<Node>([root])
  const queue: Node[] = [root]
  while (queue.length) {
    const node = queue.shift()!
    for (const dependency of node.edges) {
      const target = node.resolve(dependency.name)
      if (target && !used.has(target)) {
        used.add(target)
        queue.push(target)
      }
    }
  }
  for (const node of [...root.descendants()]) if (!used.has(node)) node.parent?.children.delete(node.name)
  markFlags(root)
  return root
}

export function lockfileFor(root: Node, manifest: Manifest): Lockfile {
  const rootEntry: LockEntry = { name: manifest.name, version: manifest.version }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    if (manifest[field] && Object.keys(manifest[field]!).length) rootEntry[field] = manifest[field]
  }
  if (manifest.bin) rootEntry.bin = manifest.bin
  const packages: Record<string, LockEntry> = { '': rootEntry }
  for (const node of root.descendants()) {
    const entry: LockEntry = {}
    if (node.manifest.name && node.manifest.name !== node.name) entry.name = node.manifest.name
    entry.version = node.version
    if (node.resolved) entry.resolved = node.resolved
    if (node.integrity) entry.integrity = node.integrity
    if (node.dev) entry.dev = true
    if (node.optional) entry.optional = true
    if (node.peer) entry.peer = true
    for (const field of MANIFEST_FIELDS) {
      const value = node.manifest[field]
      if (value !== undefined && !(typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length)) {
        ;(entry as Record<string, unknown>)[field] = value
      }
    }
    packages[node.path] = entry
  }
  return { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages }
}
