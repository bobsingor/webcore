// Making node_modules match the tree: remove what's extraneous or changed, download and unpack
// what's missing (in the kernel, one syscall per package, ADR-0015), then link bins.
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isSysError, sys } from '../lib/kernel.ts'
import { NpmError, type Manifest, type Registry } from './registry.ts'
import type { Node } from './tree.ts'

const CONCURRENCY = 16

export interface ReifyResult {
  added: number
  removed: number
  changed: number
  /** Dependencies whose install scripts were skipped. */
  scripts: string[]
}

/** Installed packages under `dir`/node_modules, recursively: install path → version. */
function installed(prefix: string, path = ''): Map<string, string> {
  const found = new Map<string, string>()
  const modules = join(prefix, path, 'node_modules')
  let names: string[]
  try {
    names = readdirSync(modules)
  } catch {
    return found
  }
  const visit = (name: string) => {
    const relative = `${path ? `${path}/` : ''}node_modules/${name}`
    try {
      if (lstatSync(join(prefix, relative)).isSymbolicLink()) return
      const manifest = JSON.parse(readFileSync(join(prefix, relative, 'package.json'), 'utf8')) as Manifest
      found.set(relative, manifest.version)
    } catch {
      found.set(relative, '')
    }
    for (const [nested, version] of installed(prefix, relative)) found.set(nested, version)
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    if (name.startsWith('@')) {
      try {
        for (const scoped of readdirSync(join(modules, name))) visit(`${name}/${scoped}`)
      } catch {
        // Not a directory.
      }
    } else visit(name)
  }
  return found
}

/** A package's bins as { name: relative path }. */
export function binsOf(manifest: Manifest, installName: string): Record<string, string> {
  const bin = manifest.bin
  if (!bin) return {}
  const entries = typeof bin === 'string' ? { [installName.replace(/^@[^/]+\//, '')]: bin } : bin
  const out: Record<string, string> = {}
  for (const [name, path] of Object.entries(entries)) {
    const cleanName = name.replace(/^@[^/]+\//, '')
    const cleanPath = String(path).replace(/^\.\//, '')
    if (!cleanName || cleanName.includes('/') || cleanPath.split('/').includes('..')) continue
    out[cleanName] = cleanPath
  }
  return out
}

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const run = async () => {
    while (next < items.length) await worker(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
}

export async function reify(root: Node, prefix: string, registry: Registry, onProgress?: (done: number, total: number) => void): Promise<ReifyResult> {
  const desired = new Map<string, Node>()
  for (const node of root.descendants()) desired.set(node.path, node)
  const existing = installed(prefix)

  // A package whose parent directory is replaced goes with it.
  const install: Node[] = []
  const reinstalled = new Set<string>()
  let changed = 0
  for (const [path, node] of desired) {
    const parentReplaced = node.parent?.parent && reinstalled.has(node.parent.path)
    if (existing.get(path) === node.version && !parentReplaced) continue
    if (existing.has(path)) changed++
    reinstalled.add(path)
    install.push(node)
  }
  let removed = 0
  for (const path of existing.keys()) {
    if (desired.has(path) && !reinstalled.has(path)) continue
    if (!desired.has(path)) removed++
    rmSync(join(prefix, path), { recursive: true, force: true })
  }

  let done = 0
  await pool(install, CONCURRENCY, async (node) => {
    if (!node.resolved) throw new NpmError('ENORESOLVED', `${node.label} has no tarball URL`)
    const tarball = await registry.tarball(node.resolved)
    try {
      await sys.extract(tarball, join(prefix, node.path), { strip: 1, integrity: node.integrity })
      registry.release(node.resolved)
    } catch (error) {
      if (isSysError(error, 'EBADMSG')) {
        throw new NpmError('EINTEGRITY', `${node.label}: the tarball's integrity check failed (${node.integrity})`)
      }
      throw error
    }
    onProgress?.(++done, install.length)
  })

  linkBins(root, prefix)
  const scripts = install.filter((node) => node.manifest.hasInstallScript).map((node) => node.label)
  return { added: install.length - changed, removed, changed, scripts }
}

/** Registry metadata has bins; a package installed from a tarball URL has only its package.json. */
function manifestOf(node: Node, prefix: string): Manifest {
  if (node.manifest.dist || node.manifest.bin) return node.manifest
  try {
    return JSON.parse(readFileSync(join(prefix, node.path, 'package.json'), 'utf8')) as Manifest
  } catch {
    return node.manifest
  }
}

/** node_modules/.bin/<name> → ../<package>/<bin>, for each package, beside it. */
function linkBins(root: Node, prefix: string): void {
  const byDirectory = new Map<string, Node[]>()
  for (const node of root.descendants()) {
    const dir = node.parent!.path
    if (!byDirectory.has(dir)) byDirectory.set(dir, [])
    byDirectory.get(dir)!.push(node)
  }
  for (const [dir, nodes] of byDirectory) {
    const binDir = join(prefix, dir, 'node_modules', '.bin')
    rmSync(binDir, { recursive: true, force: true })
    const linked = new Set<string>()
    for (const node of nodes) {
      for (const [name, path] of Object.entries(binsOf(manifestOf(node, prefix), node.name))) {
        if (linked.has(name)) continue
        linked.add(name)
        mkdirSync(binDir, { recursive: true })
        symlinkSync(`../${node.name}/${path}`, join(binDir, name))
      }
    }
  }
}
