// Node's `process` object and its stdio streams, backed by fds 0–2.
import type { BootMessage } from '../../abi/protocol.ts'
import type { SyscallClient } from '../../process/syscalls.ts'
import { Buffer } from './buffer.ts'
import { systemError } from './errors.ts'
import { EventEmitter } from './events.ts'
import type { EventLoop } from './loop.ts'

export const NODE_VERSION = 'v22.12.0'

type WriteCallback = (error?: Error | null) => void

/** stdout/stderr: synchronous writes, like Node's for files and TTYs. */
export class WriteStream extends EventEmitter {
  readonly fd: number
  readonly isTTY = false
  readonly writable = true
  columns = 80
  rows = 24
  private readonly sys: SyscallClient

  constructor(sys: SyscallClient, fd: number) {
    super()
    this.sys = sys
    this.fd = fd
  }

  write(chunk: string | Uint8Array, encoding?: string | WriteCallback, callback?: WriteCallback): boolean {
    if (typeof encoding === 'function') {
      callback = encoding
      encoding = undefined
    }
    const data = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
    try {
      this.sys.call('write', this.fd, data)
    } catch (error) {
      throw systemError(error, 'write')
    }
    if (callback) queueMicrotask(() => (callback as WriteCallback)(null))
    return true
  }

  end(chunk?: string | Uint8Array | (() => void), encoding?: string | (() => void), callback?: () => void): this {
    if (typeof chunk === 'function') callback = chunk
    else if (chunk !== undefined) this.write(chunk, typeof encoding === 'string' ? encoding : undefined)
    if (typeof encoding === 'function') callback = encoding
    queueMicrotask(() => {
      this.emit('finish')
      callback?.()
    })
    return this
  }

  cork(): void {}
  uncork(): void {}

  setDefaultEncoding(): this {
    return this
  }

  getColorDepth(): number {
    return 1
  }

  hasColors(): boolean {
    return false
  }
}

/** stdin: flowing-mode reads over async syscalls, so a waiting reader never blocks the loop. */
export class ReadStream extends EventEmitter {
  readonly fd = 0
  readonly isTTY = false
  readableEnded = false
  private encoding?: string
  private flowing = false
  private reading = false
  private readonly sys: SyscallClient
  private readonly loop: EventLoop

  constructor(sys: SyscallClient, loop: EventLoop) {
    super()
    this.sys = sys
    this.loop = loop
  }

  override on(name: string | symbol, listener: (...args: any[]) => void): this {
    super.on(name, listener)
    if (name === 'data') this.resume()
    return this
  }

  setEncoding(encoding: string): this {
    this.encoding = encoding
    return this
  }

  resume(): this {
    if (!this.flowing && !this.readableEnded) {
      this.flowing = true
      void this.pump()
    }
    return this
  }

  pause(): this {
    this.flowing = false
    return this
  }

  pipe<T extends { write(chunk: unknown): unknown; end?(): unknown }>(destination: T, options?: { end?: boolean }): T {
    this.on('data', (chunk) => destination.write(chunk))
    this.on('end', () => {
      const isStdio = destination instanceof WriteStream
      if (options?.end !== false && !isStdio) destination.end?.()
    })
    return destination
  }

  read(): null {
    return null
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer | string> {
    for (;;) {
      const chunk = await this.loop.track(this.sys.callAsync('read', 0, this.sys.maxPayload))
      if (!chunk.length) {
        this.readableEnded = true
        return
      }
      yield this.decode(chunk)
    }
  }

  private async pump(): Promise<void> {
    if (this.reading) return
    this.reading = true
    this.loop.ref()
    try {
      while (this.flowing && !this.readableEnded) {
        const chunk = await this.sys.callAsync('read', 0, this.sys.maxPayload)
        if (!chunk.length) {
          this.readableEnded = true
          this.emit('end')
          this.emit('close')
          break
        }
        this.emit('data', this.decode(chunk))
      }
    } catch (error) {
      this.emit('error', systemError(error, 'read'))
    } finally {
      this.reading = false
      this.loop.unref()
    }
  }

  private decode(chunk: Uint8Array): Buffer | string {
    const buffer = Buffer.wrap(chunk)
    return this.encoding ? buffer.toString(this.encoding) : buffer
  }
}

export interface NodeProcess extends EventEmitter {
  argv: string[]
  env: Record<string, string>
  exitCode: number | undefined
  stdin: ReadStream
  stdout: WriteStream
  stderr: WriteStream
  exit(code?: number): never
  cwd(): string
  [key: string]: unknown
}

export function createProcess(
  boot: BootMessage,
  sys: SyscallClient,
  loop: EventLoop,
  exit: (code: number) => never,
): NodeProcess {
  const proc = new EventEmitter() as NodeProcess
  const stdout = new WriteStream(sys, 1)
  const stderr = new WriteStream(sys, 2)
  const hrtime = (previous?: [number, number]): [number, number] => {
    const ns = BigInt(Math.round(performance.now() * 1e6))
    const seconds = Number(ns / 1_000_000_000n)
    const nanos = Number(ns % 1_000_000_000n)
    if (!previous) return [seconds, nanos]
    const deltaNanos = nanos - previous[1]
    return deltaNanos < 0 ? [seconds - previous[0] - 1, deltaNanos + 1e9] : [seconds - previous[0], deltaNanos]
  }

  Object.assign(proc, {
    title: 'node',
    version: NODE_VERSION,
    versions: { node: NODE_VERSION.slice(1), webcore: '0.0.0' },
    arch: 'wasm32',
    platform: 'linux',
    release: { name: 'node' },
    pid: boot.pid,
    ppid: boot.ppid,
    execPath: boot.execPath,
    execArgv: [],
    argv: [boot.execPath],
    argv0: boot.argv[0],
    env: { ...boot.env },
    exitCode: undefined,
    config: { variables: {} },
    features: {},
    stdin: new ReadStream(sys, loop),
    stdout,
    stderr,
    exit: (code?: number) => exit(code ?? proc.exitCode ?? 0),
    cwd: () => sys.call('getcwd'),
    chdir: (directory: string) => {
      try {
        sys.call('chdir', directory)
      } catch (error) {
        throw systemError(error, 'chdir', directory)
      }
    },
    nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => callback(...args)),
    hrtime: Object.assign(hrtime, { bigint: () => BigInt(Math.round(performance.now() * 1e6)) }),
    uptime: () => performance.now() / 1000,
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
    cpuUsage: () => ({ user: 0, system: 0 }),
    umask: () => 0o022,
    getuid: () => 1000,
    getgid: () => 1000,
    geteuid: () => 1000,
    getegid: () => 1000,
    emitWarning: (warning: string | Error) => {
      const text = warning instanceof Error ? `${warning.name}: ${warning.message}` : `Warning: ${warning}`
      stderr.write(`(node:${boot.pid}) ${text}\n`)
    },
    kill: () => {
      throw new Error('process.kill is not supported yet')
    },
  })
  return proc
}
