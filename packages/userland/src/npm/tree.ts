// The dependency tree: what goes where under node_modules. Built like npm's arborist: breadth
// first from the root, reusing a visible copy when it satisfies a dependency, otherwise placing the
// picked version as high as it can go without changing what any other package resolves.
import { NpmError, parseSpec, pickVersion, specAccepts, type Manifest, type Registry, type Spec } from './registry.ts'

export type EdgeType = 'prod' | 'dev' | 'optional' | 'peer'

export interface Edge {
  name: string
  spec: Spec
  /** The spec as written. */
  raw: string
  type: EdgeType
}

export class Node {
  readonly name: string
  readonly version: string
  readonly manifest: Manifest
  readonly parent: Node | null
  readonly children = new Map<string, Node>()
  readonly edges: Edge[]
  resolved?: string
  integrity?: string
  dev = false
  optional = false
  peer = false

  constructor(name: string, version: string, manifest: Manifest, parent: Node | null, edges: Edge[]) {
    this.name = name
    this.version = version
    this.manifest = manifest
    this.parent = parent
    this.edges = edges
  }

  /** Relative to the project: '' for the root, else node_modules/a[/node_modules/b…]. */
  get path(): string {
    if (!this.parent) return ''
    return this.parent.parent ? `${this.parent.path}/node_modules/${this.name}` : `node_modules/${this.name}`
  }

  get label(): string {
    return this.parent ? `${this.name}@${this.version}` : 'the root project'
  }

  /** Where `name` resolves from this package, by Node's lookup through node_modules directories. */
  resolve(name: string): Node | undefined {
    for (let at: Node | null = this; at; at = at.parent) {
      const child = at.children.get(name)
      if (child) return child
    }
    return undefined
  }

  /** Every package in the tree below this one, parents before children. */
  *descendants(): Generator<Node> {
    for (const name of [...this.children.keys()].sort()) {
      const child = this.children.get(name)!
      yield child
      yield* child.descendants()
    }
  }
}

// --- platform --------------------------------------------------------------------------------

const PLATFORM = { os: process.platform as string, cpu: process.arch as string }
// napi-rs and esbuild name their native binaries after the platform: pkg-linux-x64-gnu, @scope/darwin-arm64.
const PLATFORM_PACKAGE = /(^|[-/])(darwin|linux|win32|freebsd|android|openharmony|sunos|aix|netbsd|openbsd)-/

function allows(list: string[] | undefined, value: string): boolean {
  if (!list?.length) return true
  if (list.includes(`!${value}`)) return false
  const positive = list.filter((entry) => !entry.startsWith('!'))
  return !positive.length || positive.includes(value)
}

/** Whether a package can run here (linux/wasm32). Packages that need a particular libc can't. */
export function platformAllows(manifest: Manifest): boolean {
  return allows(manifest.os, PLATFORM.os) && allows(manifest.cpu, PLATFORM.cpu) && !manifest.libc?.length
}

// --- edges -----------------------------------------------------------------------------------

function bundled(manifest: Manifest): Set<string> {
  const list = manifest.bundleDependencies ?? manifest.bundledDependencies
  if (list === true) return new Set(Object.keys(manifest.dependencies ?? {}))
  return new Set(Array.isArray(list) ? list : [])
}

function edge(name: string, raw: string, type: EdgeType): Edge {
  return { name, raw, type, spec: parseSpec(name, raw) }
}

/** The dependencies npm would install for a package (or, with `root`, for the project). */
export function edgesOf(manifest: Manifest, root = false): Edge[] {
  const edges = new Map<string, Edge>()
  const skip = root ? new Set<string>() : bundled(manifest)
  for (const [name, raw] of Object.entries(manifest.peerDependencies ?? {})) {
    if (manifest.peerDependenciesMeta?.[name]?.optional) continue
    edges.set(name, edge(name, raw, root ? 'prod' : 'peer'))
  }
  for (const [name, raw] of Object.entries(manifest.dependencies ?? {})) edges.set(name, edge(name, raw, 'prod'))
  if (root) for (const [name, raw] of Object.entries(manifest.devDependencies ?? {})) edges.set(name, edge(name, raw, 'dev'))

  // Native binaries for other platforms are skipped by name, without fetching them. napi-rs
  // packages also publish a wasm32-wasi build, which runs here (ADR-0006).
  let wasmBuild: Edge | undefined
  for (const [name, raw] of Object.entries(manifest.optionalDependencies ?? {})) {
    const platform = PLATFORM_PACKAGE.exec(name)
    if (platform && !name.includes('wasm32')) {
      edges.delete(name)
      const base = name.slice(0, platform.index + platform[1].length).replace(/[-/]$/, '')
      const wasm = `${base}${name.startsWith('@') && !base.includes('/') ? '/' : '-'}wasm32-wasi`
      if (!manifest.optionalDependencies?.[wasm]) wasmBuild ??= edge(wasm, raw, 'optional')
      continue
    }
    edges.set(name, edge(name, raw, 'optional'))
  }
  if (wasmBuild && !edges.has(wasmBuild.name)) edges.set(wasmBuild.name, wasmBuild)
  for (const name of skip) edges.delete(name)
  return [...edges.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export function accepts(edge: Edge, node: Node): boolean {
  if (edge.spec.type === 'tarball') return node.resolved === edge.spec.url
  if (edge.spec.name !== node.manifest.name && node.manifest.name) return false
  // A tag accepts whatever is installed; tags move, and npm doesn't re-resolve them.
  return edge.spec.type === 'tag' || specAccepts(edge.spec, node.version)
}

// --- building --------------------------------------------------------------------------------

export interface BuildOptions {
  warn(message: string): void
  /** Start downloading each package as soon as it's placed (when it will be installed). */
  prefetchTarballs?: boolean
}

export class TreeBuilder {
  private readonly registry: Registry
  private readonly options: BuildOptions

  constructor(registry: Registry, options: BuildOptions) {
    this.registry = registry
    this.options = options
  }

  private get prefetchTarballs(): boolean {
    return this.options.prefetchTarballs ?? false
  }

  async build(manifest: Manifest): Promise<Node> {
    const root = new Node(manifest.name ?? '', manifest.version ?? '', manifest, null, edgesOf(manifest, true))
    const queue: Node[] = [root]
    this.prefetch(root)
    while (queue.length) {
      const node = queue.shift()!
      for (const dependency of node.edges) {
        const existing = node.resolve(dependency.name)
        if (existing && accepts(dependency, existing)) continue
        const child = await this.place(node, dependency)
        if (child) {
          queue.push(child)
          this.prefetch(child)
        }
      }
    }
    markFlags(root)
    return root
  }

  /** Starts fetching packuments for a package's dependencies before they're needed. */
  private prefetch(node: Node): void {
    for (const { spec } of node.edges) if (spec.type !== 'tarball') this.registry.packument(spec.name).catch(() => {})
  }

  private async manifestFor(dependency: Edge): Promise<Manifest | undefined> {
    const { spec } = dependency
    if (spec.type === 'tarball') {
      return { name: spec.name, version: '0.0.0-tarball', dist: { tarball: spec.url } }
    }
    const packument = await this.registry.packument(spec.name)
    return pickVersion(packument, spec)
  }

  private async place(node: Node, dependency: Edge): Promise<Node | undefined> {
    let manifest: Manifest | undefined
    try {
      manifest = await this.manifestFor(dependency)
    } catch (error) {
      if (dependency.type === 'optional') return undefined
      throw error
    }
    if (!manifest) {
      if (dependency.type === 'optional') return undefined
      throw new NpmError('ETARGET', `No matching version found for ${dependency.name}@${dependency.raw}.`)
    }
    if (!platformAllows(manifest)) {
      if (dependency.type !== 'optional') {
        this.options.warn(`EBADPLATFORM skipping ${manifest.name}@${manifest.version}: it is built for ${[...(manifest.os ?? []), ...(manifest.cpu ?? [])].join('/') || 'another platform'}`)
      }
      return undefined
    }
    const target = this.findTarget(node, dependency, manifest.version)
    if (!target) {
      this.options.warn(`ERESOLVE could not place ${dependency.name}@${manifest.version} for ${node.label}: peer ${dependency.name}@"${dependency.raw}" conflicts with an existing copy`)
      return undefined
    }
    const child = new Node(dependency.name, manifest.version, manifest, target, edgesOf(manifest))
    child.resolved = manifest.dist?.tarball
    child.integrity = manifest.dist?.integrity ?? (manifest.dist?.shasum ? shasumToIntegrity(manifest.dist.shasum) : undefined)
    target.children.set(dependency.name, child)
    // Downloads overlap with resolving the rest of the tree.
    if (child.resolved && this.prefetchTarballs) this.registry.tarball(child.resolved).catch(() => {})
    if (manifest.deprecated) this.options.warn(`deprecated ${manifest.name}@${manifest.version}: ${manifest.deprecated}`)
    return child
  }

  /**
   * The highest node_modules directory where `name@version` can live: visible from `node`, below
   * any conflicting copy, and not shadowing a different version for anything that already
   * resolves `name` through it. A peer must be visible from the dependent's parent as well.
   */
  private findTarget(node: Node, dependency: Edge, version: string): Node | undefined {
    const start = dependency.type === 'peer' && node.parent ? node.parent : node
    const candidates: Node[] = []
    for (let at: Node | null = start; at; at = at.parent) {
      if (at.children.has(dependency.name)) break
      candidates.push(at)
    }
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (canPlace(candidates[i], dependency.name, version)) return candidates[i]
    }
    return undefined
  }
}

/** Whether every package that would resolve `name` through `at` accepts `version`. */
function canPlace(at: Node, name: string, version: string): boolean {
  const stack = [at]
  while (stack.length) {
    const node = stack.pop()!
    for (const dependency of node.edges) {
      if (dependency.name !== name) continue
      if (dependency.spec.type === 'range' && !specAccepts(dependency.spec, version)) return false
    }
    for (const [childName, child] of node.children) {
      // A nearer copy shadows ours for the whole subtree below it.
      if (childName === name || child.children.has(name)) continue
      stack.push(child)
    }
  }
  return true
}

/**
 * dev: reachable only through the root's devDependencies. optional: only through optional
 * dependencies. peer: only through peer dependencies (as npm's lockfile records them).
 */
export function markFlags(root: Node): void {
  const all = [...root.descendants()]
  const reach = (follow: (edge: Edge, from: Node) => boolean): Set<Node> => {
    const seen = new Set<Node>()
    const queue: Node[] = [root]
    while (queue.length) {
      const node = queue.shift()!
      for (const dependency of node.edges) {
        if (!follow(dependency, node)) continue
        const target = node.resolve(dependency.name)
        if (target && !seen.has(target)) {
          seen.add(target)
          queue.push(target)
        }
      }
    }
    return seen
  }
  const prod = reach((dependency, from) => from.parent !== null || dependency.type !== 'dev')
  const required = reach((dependency) => dependency.type !== 'optional')
  const nonPeer = reach((dependency) => dependency.type !== 'peer')
  for (const node of all) {
    node.dev = !prod.has(node)
    node.optional = !required.has(node)
    node.peer = !nonPeer.has(node)
  }
}

function shasumToIntegrity(shasum: string): string {
  const bytes = shasum.match(/../g)!.map((pair) => Number.parseInt(pair, 16))
  return `sha1-${btoa(String.fromCharCode(...bytes))}`
}
