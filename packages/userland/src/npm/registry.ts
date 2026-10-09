// The npm registry: configuration (.npmrc, npm_config_*), package specs, packuments, and picking a
// version for a spec. Requests go through the host's fetch, so the registry must allow CORS
// (registry.npmjs.org does).
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { compareVersions, maxSatisfying, satisfies, valid, validRange } from './semver.ts'

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

export interface Manifest {
  name: string
  version: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  bundleDependencies?: string[] | boolean
  bundledDependencies?: string[] | boolean
  bin?: string | Record<string, string>
  engines?: Record<string, string>
  os?: string[]
  cpu?: string[]
  libc?: string[]
  deprecated?: string
  hasInstallScript?: boolean
  license?: string
  dist?: { tarball: string; integrity?: string; shasum?: string }
}

export interface Packument {
  name: string
  'dist-tags': Record<string, string>
  versions: Record<string, Manifest>
}

/** A dependency spec, as found in package.json or on the command line. */
export type Spec =
  | { type: 'range'; name: string; range: string }
  | { type: 'tag'; name: string; tag: string }
  | { type: 'tarball'; name: string; url: string }

export class NpmError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * Parses the value of a dependency entry (`name` is its key). `npm:` aliases resolve to the real
 * package name.
 */
export function parseSpec(name: string, value: string): Spec {
  value = value.trim()
  if (value.startsWith('npm:')) {
    const { name: real, rest } = splitNameAndRest(value.slice(4))
    return parseSpec(real, rest || 'latest')
  }
  if (/^https?:\/\//.test(value)) return { type: 'tarball', name, url: value }
  if (/^(file|link|git|git\+[a-z]+|github|gitlab|bitbucket|workspace):/.test(value) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(value)) {
    throw new NpmError('EUNSUPPORTEDPROTOCOL', `Unsupported dependency spec for ${name}: "${value}" (webcore's npm installs from the registry and tarball URLs)`)
  }
  if (value === '' || value === '*' || value === 'latest') return { type: 'tag', name, tag: 'latest' }
  if (validRange(value)) return { type: 'range', name, range: value }
  if (/^[A-Za-z][\w.-]*$/.test(value)) return { type: 'tag', name, tag: value }
  throw new NpmError('EINVALIDTAGNAME', `Invalid version range for ${name}: "${value}"`)
}

function splitNameAndRest(text: string): { name: string; rest: string } {
  const at = text.indexOf('@', text.startsWith('@') ? 1 : 0)
  return at < 0 ? { name: text, rest: '' } : { name: text.slice(0, at), rest: text.slice(at + 1) }
}

/** Parses a command-line spec: `react`, `react@^18`, `@scope/pkg@latest`, `alias@npm:pkg@1`. */
export function parseArgSpec(arg: string): { alias: string; spec: Spec; raw: string } {
  const { name, rest } = splitNameAndRest(arg)
  if (/^https?:\/\//.test(arg)) {
    const base = arg.split('/').pop()!.replace(/\.tgz$/, '').replace(/-\d+\.\d+\.\d+.*$/, '')
    return { alias: base, spec: { type: 'tarball', name: base, url: arg }, raw: arg }
  }
  return { alias: name, spec: parseSpec(name, rest || 'latest'), raw: rest }
}

// --- configuration ---------------------------------------------------------------------------

export interface Config {
  registry: string
  scopes: Record<string, string>
}

function readNpmrc(path: string, into: Config): void {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^#;=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    const [, key, raw] = match
    const value = raw.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? '')
    if (key === 'registry') into.registry = value
    else if (/^@[^:]+:registry$/.test(key)) into.scopes[key.slice(0, key.indexOf(':'))] = value
  }
}

/** npm's config precedence, for the settings we use: environment over project over user. */
export function loadConfig(prefix: string): Config {
  const config: Config = { registry: DEFAULT_REGISTRY, scopes: {} }
  readNpmrc(join(homedir(), '.npmrc'), config)
  readNpmrc(join(prefix, '.npmrc'), config)
  const env = process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY
  if (env) config.registry = env
  if (!config.registry.endsWith('/')) config.registry += '/'
  for (const scope of Object.keys(config.scopes)) if (!config.scopes[scope].endsWith('/')) config.scopes[scope] += '/'
  return config
}

// --- the registry client ---------------------------------------------------------------------

const ABBREVIATED = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*'

export class Registry {
  readonly config: Config
  private readonly packuments = new Map<string, Promise<Packument>>()
  private readonly tarballs = new Map<string, Promise<Uint8Array>>()

  constructor(config: Config) {
    this.config = config
  }

  registryFor(name: string): string {
    const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : undefined
    return (scope && this.config.scopes[scope]) || this.config.registry
  }

  /** The abbreviated packument: every version's install-relevant metadata. Cached per run. */
  packument(name: string): Promise<Packument> {
    let pending = this.packuments.get(name)
    if (!pending) {
      const url = `${this.registryFor(name)}${name.replace('/', '%2f')}`
      pending = this.fetch(url, { accept: ABBREVIATED }).then(async (response) => {
        if (response.status === 404) throw new NpmError('E404', `404 Not Found - GET ${url} - '${name}' is not in this registry.`)
        if (!response.ok) throw new NpmError(`E${response.status}`, `${response.status} ${response.statusText} - GET ${url}`)
        return (await response.json()) as Packument
      })
      this.packuments.set(name, pending)
    }
    return pending
  }

  /** Downloads a tarball; repeated calls share one download, so it can start early. */
  tarball(url: string): Promise<Uint8Array> {
    let pending = this.tarballs.get(url)
    if (!pending) {
      pending = this.fetch(url).then(async (response) => {
        if (!response.ok) throw new NpmError(`E${response.status}`, `${response.status} ${response.statusText} - GET ${url}`)
        return new Uint8Array(await response.arrayBuffer())
      })
      this.tarballs.set(url, pending)
    }
    return pending
  }

  /** Forgets a downloaded tarball once it's unpacked. */
  release(url: string): void {
    this.tarballs.delete(url)
  }

  /** fetch with retries for network errors and 5xx responses. */
  private async fetch(url: string, headers: Record<string, string> = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(url, { headers })
        if (response.status < 500 || attempt >= 2) return response
      } catch (error) {
        if (attempt >= 2) {
          throw new NpmError('ENETWORK', `request to ${url} failed: ${(error as Error).message}. The registry must be reachable from this browser (CORS).`)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt))
    }
  }
}

/**
 * Picks a version for a spec, as npm-pick-manifest does: a dist-tag directly; for a range, the
 * `latest` tag if it satisfies, else the highest satisfying version, avoiding deprecated ones.
 */
export function pickVersion(packument: Packument, spec: Spec): Manifest | undefined {
  const versions = packument.versions
  if (spec.type === 'tag') {
    const tagged = packument['dist-tags'][spec.tag]
    return tagged ? versions[tagged] : undefined
  }
  if (spec.type !== 'range') return undefined
  if (valid(spec.range) && versions[valid(spec.range)!]) return versions[valid(spec.range)!]
  const latest = packument['dist-tags'].latest
  if (latest && versions[latest] && !versions[latest].deprecated && satisfies(latest, spec.range)) return versions[latest]
  const all = Object.keys(versions)
  const live = all.filter((version) => !versions[version].deprecated)
  const best = maxSatisfying(live, spec.range) ?? maxSatisfying(all, spec.range)
  return best ? versions[best] : undefined
}

/** Whether `version` satisfies a dependency spec (tags only match their current target). */
export function specAccepts(spec: Spec, version: string, packument?: Packument): boolean {
  if (spec.type === 'range') return satisfies(version, spec.range) || (valid(spec.range) !== undefined && valid(spec.range) === version)
  if (spec.type === 'tag') return packument ? packument['dist-tags'][spec.tag] === version : spec.tag === 'latest'
  return true
}

export function newestFirst(versions: string[]): string[] {
  return [...versions].sort((a, b) => compareVersions(b, a))
}
