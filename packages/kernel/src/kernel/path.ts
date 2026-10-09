/** Normalizes an absolute path: collapses `.`, `..` and duplicate slashes. */
export function normalize(path: string): string {
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  return `/${out.join('/')}`
}

export function resolve(base: string, path: string): string {
  return normalize(path.startsWith('/') ? path : `${base}/${path}`)
}

export function segments(path: string): string[] {
  return normalize(path).split('/').filter(Boolean)
}

export function dirname(path: string): string {
  const parts = segments(path)
  parts.pop()
  return `/${parts.join('/')}`
}

export function basename(path: string): string {
  return segments(path).pop() ?? ''
}
