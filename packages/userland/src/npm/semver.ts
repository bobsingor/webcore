// Semantic versions and npm's range syntax, with node-semver's semantics: x-ranges, ~, ^, hyphen
// ranges, ||, and the rule that a prerelease satisfies a range only if a comparator in the same set
// names that exact major.minor.patch with a prerelease.

export interface SemVer {
  major: number
  minor: number
  patch: number
  prerelease: (string | number)[]
  version: string
}

const VERSION = /^\s*[v=]*\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\s*$/
const PARTIAL = /^[v=]*(\d+|[xX*])?(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-.]+)?$/
const MAX_SAFE = Number.MAX_SAFE_INTEGER

export function parse(version: string): SemVer | undefined {
  const match = VERSION.exec(version)
  if (!match) return undefined
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number)
  if (major > MAX_SAFE || minor > MAX_SAFE || patch > MAX_SAFE) return undefined
  const prerelease = match[4] ? match[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : []
  return { major, minor, patch, prerelease, version: `${major}.${minor}.${patch}${match[4] ? `-${match[4]}` : ''}` }
}

export function valid(version: string): string | undefined {
  return parse(version)?.version
}

export function compare(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  // A prerelease sorts before its release.
  if (!a.prerelease.length || !b.prerelease.length) return b.prerelease.length - a.prerelease.length
  for (let i = 0; ; i++) {
    const x = a.prerelease[i]
    const y = b.prerelease[i]
    if (x === undefined && y === undefined) return 0
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
}

export function compareVersions(a: string, b: string): number {
  return compare(parse(a)!, parse(b)!)
}

// --- ranges ----------------------------------------------------------------------------------

type Operator = '<' | '<=' | '>' | '>=' | '='

interface Comparator {
  operator: Operator
  version: SemVer
}

/** A union of comparator sets; an empty set matches every release. */
type Range = Comparator[][]

const cache = new Map<string, Range | null>()

function version(major: number, minor: number, patch: number, prerelease: (string | number)[] = []): SemVer {
  return { major, minor, patch, prerelease, version: `${major}.${minor}.${patch}${prerelease.length ? `-${prerelease.join('.')}` : ''}` }
}

const isX = (part: string | undefined) => part === undefined || part === '' || part === 'x' || part === 'X' || part === '*'

/** Parses a partial version ("1", "1.2", "1.x", "1.2.3-beta"). */
function partial(text: string): { M?: number; m?: number; p?: number; pre: (string | number)[] } | undefined {
  const match = PARTIAL.exec(text)
  if (!match) return undefined
  const M = isX(match[1]) ? undefined : Number(match[1])
  const m = M === undefined || isX(match[2]) ? undefined : Number(match[2])
  const p = m === undefined || isX(match[3]) ? undefined : Number(match[3])
  const pre = p !== undefined && match[4] ? match[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : []
  return { M, m, p, pre }
}

/** Desugars one comparator token into plain comparators. */
function comparators(token: string): Comparator[] | undefined {
  const op = /^(~>?|\^|>=|<=|>|<|=)?\s*(.*)$/.exec(token)!
  const operator = op[1] ?? ''
  const parsed = partial(op[2])
  if (!parsed) return undefined
  const { M, m, p, pre } = parsed
  const gte = (v: SemVer): Comparator => ({ operator: '>=', version: v })
  const lt = (v: SemVer): Comparator => ({ operator: '<', version: v })

  if (operator === '~' || operator === '~>') {
    if (M === undefined) return []
    if (m === undefined) return [gte(version(M, 0, 0)), lt(version(M + 1, 0, 0, [0]))]
    return [gte(version(M, m, p ?? 0, pre)), lt(version(M, m + 1, 0, [0]))]
  }
  if (operator === '^') {
    if (M === undefined) return []
    if (m === undefined) return [gte(version(M, 0, 0)), lt(version(M + 1, 0, 0, [0]))]
    if (p === undefined) {
      return M === 0 ? [gte(version(0, m, 0)), lt(version(0, m + 1, 0, [0]))] : [gte(version(M, m, 0)), lt(version(M + 1, 0, 0, [0]))]
    }
    const from = gte(version(M, m, p, pre))
    if (M !== 0) return [from, lt(version(M + 1, 0, 0, [0]))]
    if (m !== 0) return [from, lt(version(0, m + 1, 0, [0]))]
    return [from, lt(version(0, 0, p + 1, [0]))]
  }

  // Plain, =, >, >=, <, <= with possibly partial versions (x-ranges).
  if (M === undefined) {
    // "*" with < or > matches nothing; anything else matches everything.
    return operator === '<' || operator === '>' ? [lt(version(0, 0, 0, [0]))] : []
  }
  if (p !== undefined) return [{ operator: (operator || '=') as Operator, version: version(M, m!, p, pre) }]
  const next = m === undefined ? version(M + 1, 0, 0, [0]) : version(M, m + 1, 0, [0])
  const base = version(M, m ?? 0, 0)
  switch (operator) {
    case '':
    case '=':
      return [gte(base), lt(next)]
    case '>':
      return [gte(m === undefined ? version(M + 1, 0, 0) : version(M, m + 1, 0))]
    case '>=':
      return [gte(base)]
    case '<':
      return [lt(version(M, m ?? 0, 0, [0]))]
    case '<=':
      return [lt(next)]
  }
  return undefined
}

function parseRange(range: string): Range | null {
  const cached = cache.get(range)
  if (cached !== undefined) return cached
  let result: Range | null = []
  for (const part of range.split('||')) {
    let text = part.trim()
    const set: Comparator[] = []
    // Hyphen range: "1.2.3 - 2.3.4".
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text)
    if (hyphen) {
      const from = partial(hyphen[1])
      const to = partial(hyphen[2])
      if (!from || !to) {
        result = null
        break
      }
      if (from.M !== undefined) set.push({ operator: '>=', version: version(from.M, from.m ?? 0, from.p ?? 0, from.pre) })
      if (to.M !== undefined) {
        if (to.p !== undefined) set.push({ operator: '<=', version: version(to.M, to.m!, to.p, to.pre) })
        else if (to.m !== undefined) set.push({ operator: '<', version: version(to.M, to.m + 1, 0, [0]) })
        else set.push({ operator: '<', version: version(to.M + 1, 0, 0, [0]) })
      }
      result.push(set)
      continue
    }
    // Operators may be separated from their versions by spaces: ">= 1.2.3".
    text = text.replace(/(~>?|\^|>=|<=|>|<|=)\s+/g, '$1')
    const tokens = text.split(/\s+/).filter(Boolean)
    let ok = true
    for (const token of tokens) {
      const desugared = comparators(token)
      if (!desugared) {
        ok = false
        break
      }
      set.push(...desugared)
    }
    if (!ok) {
      result = null
      break
    }
    result.push(set)
  }
  cache.set(range, result)
  return result
}

export function validRange(range: string): boolean {
  return parseRange(range) !== null
}

function test(comparator: Comparator, v: SemVer): boolean {
  const order = compare(v, comparator.version)
  switch (comparator.operator) {
    case '<':
      return order < 0
    case '<=':
      return order <= 0
    case '>':
      return order > 0
    case '>=':
      return order >= 0
    case '=':
      return order === 0
  }
}

function testSet(set: Comparator[], v: SemVer): boolean {
  if (!set.every((comparator) => test(comparator, v))) return false
  if (!v.prerelease.length) return true
  // A prerelease only matches if the set opts into that exact major.minor.patch's prereleases.
  return set.some(
    ({ version: c }) => c.prerelease.length > 0 && c.major === v.major && c.minor === v.minor && c.patch === v.patch && !(c.prerelease.length === 1 && c.prerelease[0] === 0),
  )
}

export function satisfies(versionText: string, range: string): boolean {
  const v = parse(versionText)
  const parsed = parseRange(range)
  if (!v || !parsed) return false
  return parsed.some((set) => testSet(set, v))
}

export function maxSatisfying(versions: Iterable<string>, range: string): string | undefined {
  let best: SemVer | undefined
  for (const text of versions) {
    const v = parse(text)
    if (v && satisfies(text, range) && (!best || compare(v, best) > 0)) best = v
  }
  return best?.version
}
