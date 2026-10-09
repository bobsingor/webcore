// A compact approximation of util.inspect / util.format.

export interface InspectOptions {
  depth?: number
}

const BREAK_LENGTH = 72

function quote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
}

function formatKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key)
}

function wrap(open: string, items: string[], close: string, indent: string): string {
  if (!items.length) return `${open}${close}`
  const single = `${open} ${items.join(', ')} ${close}`
  if (single.length <= BREAK_LENGTH && !single.includes('\n')) return single
  const inner = `${indent}  `
  return `${open}\n${inner}${items.join(`,\n${inner}`)}\n${indent}${close}`
}

function formatValue(value: unknown, depth: number, seen: Set<object>, indent: string): string {
  switch (typeof value) {
    case 'string':
      return quote(value)
    case 'number':
      return Object.is(value, -0) ? '-0' : String(value)
    case 'bigint':
      return `${value}n`
    case 'symbol':
      return value.toString()
    case 'undefined':
      return 'undefined'
    case 'boolean':
      return String(value)
    case 'function': {
      const name = value.name || '(anonymous)'
      return Function.prototype.toString.call(value).startsWith('class') ? `[class ${name}]` : `[Function: ${name}]`
    }
  }
  if (value === null) return 'null'
  const object = value as Record<string, unknown>
  if (seen.has(object)) return '[Circular *1]'
  if (object instanceof Error) return object.stack ?? `${object.name}: ${object.message}`
  if (object instanceof Date) return Number.isNaN(object.getTime()) ? 'Invalid Date' : object.toISOString()
  if (object instanceof RegExp) return String(object)
  if (object instanceof Promise) return 'Promise { <pending> }'

  const ctor = (Object.getPrototypeOf(object) as { constructor?: { name?: string } } | null)?.constructor?.name
  if (object instanceof Uint8Array && ctor === 'Buffer') {
    const shown = Array.from(object.subarray(0, 50), (byte) => byte.toString(16).padStart(2, '0')).join(' ')
    const more = object.length > 50 ? ` ... ${object.length - 50} more bytes` : ''
    return `<Buffer${shown ? ` ${shown}` : ''}${more}>`
  }
  if (depth < 0) return Array.isArray(object) ? '[Array]' : `[${ctor ?? 'Object'}]`

  seen.add(object)
  try {
    const next = (item: unknown) => formatValue(item, depth - 1, seen, `${indent}  `)
    if (Array.isArray(object)) {
      const items = object.slice(0, 100).map(next)
      if (object.length > 100) items.push(`... ${object.length - 100} more items`)
      return wrap('[', items, ']', indent)
    }
    if (ArrayBuffer.isView(object) && !(object instanceof DataView)) {
      const items = Array.from(object as unknown as ArrayLike<number>).slice(0, 100).map(String)
      return wrap(`${ctor}(${(object as unknown as ArrayLike<number>).length}) [`, items, ']', indent)
    }
    if (object instanceof Map) {
      const items = [...object].map(([key, item]) => `${next(key)} => ${next(item)}`)
      return wrap(`Map(${object.size}) {`, items, '}', indent)
    }
    if (object instanceof Set) return wrap(`Set(${object.size}) {`, [...object].map(next), '}', indent)
    const items = Object.keys(object).map((key) => `${formatKey(key)}: ${next(object[key])}`)
    const prefix = ctor === undefined ? '[Object: null prototype] ' : ctor === 'Object' ? '' : `${ctor} `
    return wrap(`${prefix}{`, items, '}', indent)
  } finally {
    seen.delete(object)
  }
}

export function inspect(value: unknown, options: InspectOptions = {}): string {
  return formatValue(value, options.depth ?? 2, new Set(), '')
}

export function format(...args: unknown[]): string {
  const show = (arg: unknown) => (typeof arg === 'string' ? arg : inspect(arg))
  if (typeof args[0] !== 'string') return args.map(show).join(' ')
  let index = 1
  let out = args[0].replace(/%[sdifjoOc%]/g, (token) => {
    if (token === '%%') return '%'
    if (index >= args.length) return token
    const arg = args[index++]
    switch (token) {
      case '%s':
        return typeof arg === 'string' ? arg : typeof arg === 'object' && arg !== null ? inspect(arg, { depth: 1 }) : String(arg)
      case '%d':
        return typeof arg === 'bigint' ? `${arg}n` : String(Number(arg))
      case '%i':
        return typeof arg === 'bigint' ? `${arg}n` : String(Number.parseInt(String(arg), 10))
      case '%f':
        return String(Number.parseFloat(String(arg)))
      case '%j':
        try {
          return JSON.stringify(arg)
        } catch {
          return '[Circular]'
        }
      case '%c':
        return ''
      default:
        return inspect(arg)
    }
  })
  for (; index < args.length; index++) out += ` ${show(args[index])}`
  return out
}
