// Node's `path` module (POSIX flavour).

function normalizeSegments(parts: string[], allowAboveRoot: boolean): string[] {
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (allowAboveRoot) out.push('..')
    } else {
      out.push(part)
    }
  }
  return out
}

function assertPath(path: unknown): asserts path is string {
  if (typeof path !== 'string') {
    throw new TypeError(`The "path" argument must be of type string. Received ${typeof path}`)
  }
}

function trimTrailingSlashes(path: string): string {
  let end = path.length
  while (end > 1 && path[end - 1] === '/') end--
  return path.slice(0, end)
}

export function createPath(cwd: () => string) {
  const normalize = (path: string): string => {
    assertPath(path)
    if (path === '') return '.'
    const absolute = path.startsWith('/')
    const trailing = path.endsWith('/')
    let out = normalizeSegments(path.split('/'), !absolute).join('/')
    if (!out && !absolute) out = '.'
    if (out && trailing) out += '/'
    return (absolute ? '/' : '') + out
  }

  const resolve = (...paths: string[]): string => {
    let resolved = ''
    for (let i = paths.length - 1; i >= -1 && !resolved.startsWith('/'); i--) {
      const path = i >= 0 ? paths[i] : cwd()
      assertPath(path)
      if (path) resolved = `${path}/${resolved}`
    }
    return `/${normalizeSegments(resolved.split('/'), false).join('/')}`
  }

  const dirname = (path: string): string => {
    assertPath(path)
    if (!path) return '.'
    const trimmed = trimTrailingSlashes(path)
    const index = trimmed.lastIndexOf('/')
    if (index === -1) return '.'
    if (index === 0) return '/'
    return trimTrailingSlashes(trimmed.slice(0, index))
  }

  const basename = (path: string, ext?: string): string => {
    assertPath(path)
    const trimmed = trimTrailingSlashes(path)
    const base = trimmed === '/' ? '' : trimmed.slice(trimmed.lastIndexOf('/') + 1)
    return ext && base !== ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base
  }

  const extname = (path: string): string => {
    const base = basename(path)
    const index = base.lastIndexOf('.')
    return index <= 0 ? '' : base.slice(index)
  }

  const relative = (from: string, to: string): string => {
    const fromParts = resolve(from).split('/').filter(Boolean)
    const toParts = resolve(to).split('/').filter(Boolean)
    let common = 0
    while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common++
    return [...Array(fromParts.length - common).fill('..'), ...toParts.slice(common)].join('/')
  }

  const path = {
    sep: '/',
    delimiter: ':',
    normalize,
    resolve,
    dirname,
    basename,
    extname,
    relative,
    join: (...parts: string[]): string => {
      parts.forEach(assertPath)
      const joined = parts.filter(Boolean).join('/')
      return joined ? normalize(joined) : '.'
    },
    isAbsolute: (path: string): boolean => {
      assertPath(path)
      return path.startsWith('/')
    },
    parse: (path: string) => {
      const root = path.startsWith('/') ? '/' : ''
      const base = basename(path)
      const ext = extname(path)
      const dir = path.includes('/') ? dirname(path) : ''
      return { root, dir, base, ext, name: ext ? base.slice(0, -ext.length) : base }
    },
    format: (parts: { root?: string; dir?: string; base?: string; name?: string; ext?: string }): string => {
      const dir = parts.dir || parts.root || ''
      const base = parts.base || `${parts.name ?? ''}${parts.ext ?? ''}`
      if (!dir) return base
      return dir === parts.root ? `${dir}${base}` : `${dir}/${base}`
    },
    toNamespacedPath: (path: string): string => path,
    posix: undefined as unknown,
    win32: undefined as unknown,
  }
  path.posix = path
  path.win32 = path
  return path
}

export type NodePath = ReturnType<typeof createPath>
