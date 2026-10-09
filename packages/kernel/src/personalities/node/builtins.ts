// Small built-in modules for the M0 shim: console, util, os, url, assert.
import { format, inspect, type InspectOptions } from './inspect.ts'
import type { NodePath } from './path.ts'
import type { NodeProcess, WriteStream } from './process.ts'

export function createConsole(stdout: WriteStream, stderr: WriteStream) {
  let indent = ''
  const counts = new Map<string, number>()
  const timers = new Map<string, number>()
  const print = (stream: WriteStream) => (...args: unknown[]) => {
    const text = format(...args)
    stream.write(`${indent ? text.replace(/^/gm, indent) : text}\n`)
  }
  const log = print(stdout)
  const error = print(stderr)
  return {
    log,
    info: log,
    debug: log,
    error,
    warn: error,
    trace: (...args: unknown[]) => error(`Trace: ${format(...args)}\n${new Error().stack?.split('\n').slice(2).join('\n') ?? ''}`),
    dir: (value: unknown, options?: InspectOptions) => stdout.write(`${inspect(value, options)}\n`),
    table: (value: unknown) => stdout.write(`${inspect(value)}\n`),
    assert: (condition: unknown, ...args: unknown[]) => {
      if (!condition) error(args.length ? `Assertion failed: ${format(...args)}` : 'Assertion failed')
    },
    count: (label = 'default') => {
      const count = (counts.get(label) ?? 0) + 1
      counts.set(label, count)
      log(`${label}: ${count}`)
    },
    countReset: (label = 'default') => counts.delete(label),
    time: (label = 'default') => timers.set(label, performance.now()),
    timeLog: (label = 'default', ...args: unknown[]) => {
      const start = timers.get(label)
      if (start !== undefined) log(`${label}: ${(performance.now() - start).toFixed(3)}ms`, ...args)
    },
    timeEnd: (label = 'default') => {
      const start = timers.get(label)
      if (start === undefined) return
      timers.delete(label)
      log(`${label}: ${(performance.now() - start).toFixed(3)}ms`)
    },
    group: (...args: unknown[]) => {
      if (args.length) log(...args)
      indent += '  '
    },
    groupEnd: () => {
      indent = indent.slice(2)
    },
  }
}

export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  if (a instanceof Date) return a.getTime() === (b as Date).getTime()
  if (a instanceof Map) {
    const other = b as Map<unknown, unknown>
    return a.size === other.size && [...a].every(([key, value]) => other.has(key) && isDeepStrictEqual(value, other.get(key)))
  }
  if (a instanceof Set) {
    const other = b as Set<unknown>
    return a.size === other.size && [...a].every((value) => other.has(value))
  }
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  return (
    keysA.length === keysB.length &&
    keysA.every((key) =>
      isDeepStrictEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  )
}

export function createUtil() {
  return {
    format,
    inspect,
    isDeepStrictEqual,
    promisify:
      (fn: (...args: any[]) => void) =>
      (...args: unknown[]) =>
        new Promise((resolve, reject) =>
          fn(...args, (error: unknown, value: unknown) => (error ? reject(error) : resolve(value))),
        ),
    callbackify:
      (fn: (...args: any[]) => Promise<unknown>) =>
      (...args: unknown[]) => {
        const callback = args.pop() as (error: unknown, value?: unknown) => void
        fn(...args).then(
          (value) => callback(null, value),
          (error) => callback(error),
        )
      },
    inherits: (ctor: { prototype: object; super_?: unknown }, superCtor: { prototype: object }) => {
      Object.setPrototypeOf(ctor.prototype, superCtor.prototype)
      Object.setPrototypeOf(ctor, superCtor)
      ctor.super_ = superCtor
    },
    deprecate: <T>(fn: T) => fn,
    types: {
      isPromise: (value: unknown) => value instanceof Promise,
      isDate: (value: unknown) => value instanceof Date,
      isRegExp: (value: unknown) => value instanceof RegExp,
      isUint8Array: (value: unknown) => value instanceof Uint8Array,
    },
    TextEncoder,
    TextDecoder,
  }
}

export function createOs(proc: NodeProcess) {
  const cores = Math.max(1, globalThis.navigator?.hardwareConcurrency ?? 1)
  const homedir = () => proc.env.HOME ?? '/home/user'
  return {
    EOL: '\n',
    devNull: '/dev/null',
    platform: () => 'linux',
    type: () => 'Linux',
    arch: () => 'wasm32',
    release: () => '6.0.0-webcore',
    hostname: () => 'webcore',
    homedir,
    tmpdir: () => proc.env.TMPDIR ?? '/tmp',
    endianness: () => 'LE',
    cpus: () =>
      Array.from({ length: cores }, () => ({ model: 'webcore', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })),
    availableParallelism: () => cores,
    totalmem: () => 2 ** 31,
    freemem: () => 2 ** 30,
    uptime: () => performance.now() / 1000,
    loadavg: () => [0, 0, 0],
    networkInterfaces: () => ({}),
    userInfo: () => ({ username: proc.env.USER ?? 'user', uid: 1000, gid: 1000, shell: proc.env.SHELL ?? null, homedir: homedir() }),
    constants: { signals: {}, errno: {} },
  }
}

export function createUrl(path: NodePath) {
  return {
    URL,
    URLSearchParams,
    fileURLToPath: (url: string | URL) => {
      const parsed = typeof url === 'string' ? new URL(url) : url
      if (parsed.protocol !== 'file:') throw new TypeError('The URL must be of scheme file')
      return decodeURIComponent(parsed.pathname)
    },
    pathToFileURL: (file: string) => new URL(`file://${encodeURI(path.resolve(file))}`),
  }
}

class AssertionError extends Error {
  readonly code = 'ERR_ASSERTION'
  override name = 'AssertionError'
}

export function createAssert() {
  const fail = (message: string | Error | undefined, fallback: string): never => {
    throw message instanceof Error ? message : new AssertionError(message ?? fallback)
  }
  const ok = (value: unknown, message?: string | Error) => {
    if (!value) fail(message, 'The expression evaluated to a falsy value')
  }
  const show = (value: unknown) => inspect(value)
  const assert = Object.assign(ok, {
    ok,
    AssertionError,
    fail: (message?: string | Error) => fail(message, 'Failed'),
    equal: (actual: unknown, expected: unknown, message?: string | Error) => {
      if (actual != expected) fail(message, `${show(actual)} == ${show(expected)}`)
    },
    notEqual: (actual: unknown, expected: unknown, message?: string | Error) => {
      if (actual == expected) fail(message, `${show(actual)} != ${show(expected)}`)
    },
    strictEqual: (actual: unknown, expected: unknown, message?: string | Error) => {
      if (!Object.is(actual, expected)) fail(message, `Expected values to be strictly equal:\n\n${show(actual)} !== ${show(expected)}`)
    },
    notStrictEqual: (actual: unknown, expected: unknown, message?: string | Error) => {
      if (Object.is(actual, expected)) fail(message, `Expected "actual" to be strictly unequal to: ${show(expected)}`)
    },
    deepStrictEqual: (actual: unknown, expected: unknown, message?: string | Error) => {
      if (!isDeepStrictEqual(actual, expected)) fail(message, `Expected values to be strictly deep-equal:\n${show(actual)}\n\nshould equal\n\n${show(expected)}`)
    },
    notDeepStrictEqual: (actual: unknown, expected: unknown, message?: string | Error) => {
      if (isDeepStrictEqual(actual, expected)) fail(message, 'Expected "actual" not to be strictly deep-equal to "expected"')
    },
    match: (value: string, pattern: RegExp, message?: string | Error) => {
      if (!pattern.test(value)) fail(message, `The input did not match the regular expression ${pattern}. Input: ${show(value)}`)
    },
    throws: (fn: () => unknown, expected?: RegExp | ((error: unknown) => boolean), message?: string | Error) => {
      try {
        fn()
      } catch (error) {
        if (expected instanceof RegExp && !expected.test(String((error as Error)?.message ?? error))) {
          fail(message, `The error message did not match ${expected}`)
        }
        return
      }
      fail(message, 'Missing expected exception.')
    },
    rejects: async (promise: Promise<unknown> | (() => Promise<unknown>), message?: string | Error) => {
      try {
        await (typeof promise === 'function' ? promise() : promise)
      } catch {
        return
      }
      fail(message, 'Missing expected rejection.')
    },
  })
  return Object.assign(assert, { strict: assert, deepEqual: assert.deepStrictEqual })
}
