// libuv semantics on top of the host's event loop.
//
// Node keeps a process alive while referenced handles (timers, sockets, child processes) or
// in-flight requests exist. Calls from "native" code into JavaScript go through MakeCallback,
// which drains process.nextTick afterwards. When the loop runs dry, 'beforeExit' is emitted; if
// that schedules no new work, 'exit' is emitted and the process ends (src/api/embed_helpers.cc).
import type { SyscallClient } from '../../process/syscalls.ts'
import { host } from './host.ts'

// TickInfo and ImmediateInfo field layouts (src/env.h).
const kHasTickScheduled = 0
const kHasRejectionToWarn = 1
const kCount = 0
const kRefCount = 1
// ExitInfo (src/env.h).
const kExiting = 0
const kExitCode = 1
const kHasExitCode = 2

type Indexed = { [index: number]: number }

export class UvLoop {
  /** Shared with lib/internal/process/task_queues.js. Writes are observed (see watch()). */
  readonly tickInfo: Uint8Array
  /** Shared with lib/internal/timers.js. Writes are observed (see watch()). */
  readonly immediateInfo: Uint32Array
  /** Shared with the process object (exit_info_private_symbol). */
  readonly exitInfo = new Int32Array(3)

  tickCallback?: (this: unknown) => void
  processImmediate?: () => void
  processTimers?: (now: number) => number
  /** process.emit, available once bootstrap has made `process` an EventEmitter. */
  emit?: (name: string, ...args: unknown[]) => void
  /** errors.triggerUncaughtException; installed by the errors binding. */
  onUncaught?: (error: unknown, fromPromise: boolean) => void
  /** Runs just before the process ends (diagnostics). */
  onExit?: (code: number) => void
  process?: object

  private readonly sys: SyscallClient
  private readonly startTime = host.performance.now()
  private readonly realSetTimeout = host.setTimeout
  private readonly realClearTimeout = host.clearTimeout
  private readonly macrotasks: (() => void)[] = []
  private readonly channel = new host.MessageChannel()
  private handles = 0
  private requests = 0
  private timer: { handle?: ReturnType<typeof setTimeout>; active: boolean; refed: boolean } = {
    active: false,
    refed: true,
  }
  private depth = 0
  private draining = false
  private tickDrainQueued = false
  private immediatesQueued = false
  private aliveCheckQueued = false
  private exiting = false

  constructor(sys: SyscallClient) {
    this.sys = sys
    this.tickInfo = this.watch(new Uint8Array(2), () => this.queueTickDrain())
    this.immediateInfo = this.watch(new Uint32Array(3), () => this.queueImmediates())
    this.channel.port1.onmessage = () => this.macrotasks.shift()?.()
  }

  /** uv_now() relative to the loop start, as getLibuvNow() reports it. */
  now(): number {
    return Math.floor(host.performance.now() - this.startTime)
  }

  // --- liveness ---------------------------------------------------------------------------------

  ref(): void {
    this.handles++
  }

  unref(): void {
    this.handles--
    this.queueAliveCheck()
  }

  requestStarted(): void {
    this.requests++
  }

  requestFinished(): void {
    this.requests--
    this.queueAliveCheck()
  }

  /** Counts `promise` as a pending request until it settles. */
  track<T>(promise: Promise<T>): Promise<T> {
    this.requestStarted()
    return promise.finally(() => this.requestFinished())
  }

  isAlive(): boolean {
    return (
      this.handles > 0 ||
      this.requests > 0 ||
      (this.timer.active && this.timer.refed) ||
      this.immediateInfo[kRefCount] > 0
    )
  }

  // --- calling into JavaScript ------------------------------------------------------------------

  /** node::MakeCallback: runs `fn`, routes exceptions to the uncaught handler, drains ticks. */
  callback<T>(fn: () => T): T | undefined {
    this.depth++
    try {
      return fn()
    } catch (error) {
      this.uncaught(error, false)
      return undefined
    } finally {
      this.depth--
      if (this.depth === 0) {
        this.drainTicks()
        this.queueAliveCheck()
      }
    }
  }

  /**
   * Runs `fn` as a macrotask, inside a callback scope. Faster than setTimeout(0). Like a request
   * in libuv, a queued callback (a completion, a close callback) keeps the loop alive until it ran.
   */
  macrotask(fn: () => void): void {
    this.requests++
    this.defer(() => {
      this.requests--
      this.callback(fn)
    })
  }

  /** Runs `fn` as a bare macrotask, outside any callback scope (for "native" work). */
  defer(fn: () => void): void {
    this.macrotasks.push(fn)
    this.channel.port2.postMessage(null)
  }

  uncaught(error: unknown, fromPromise: boolean): void {
    if (this.onUncaught) {
      this.onUncaught(error, fromPromise)
      return
    }
    const text = error instanceof Error ? (error.stack ?? String(error)) : String(error)
    this.sys.call('write', 2, new host.TextEncoder().encode(`${text}\n`))
    this.reallyExit(1)
  }

  // --- process.nextTick -------------------------------------------------------------------------

  private drainTicks(): void {
    if (!this.tickCallback || this.draining) return
    if (!this.tickInfo[kHasTickScheduled] && !this.tickInfo[kHasRejectionToWarn]) return
    this.draining = true
    try {
      this.tickCallback.call(this.process)
    } catch (error) {
      this.uncaught(error, false)
    } finally {
      this.draining = false
    }
  }

  /**
   * Node drains ticks when C++ returns from a callback and between microtasks (it runs V8's
   * microtask queue explicitly). Browsers run microtasks implicitly, so a tick scheduled outside a
   * callback scope, e.g. from a promise reaction, is drained by a queued microtask instead.
   */
  private queueTickDrain(): void {
    if (this.depth > 0 || this.draining || this.tickDrainQueued) return
    if (!this.tickInfo[kHasTickScheduled] && !this.tickInfo[kHasRejectionToWarn]) return
    this.tickDrainQueued = true
    host.queueMicrotask(() => {
      this.tickDrainQueued = false
      this.callback(() => undefined)
    })
  }

  // --- timers -----------------------------------------------------------------------------------

  scheduleTimer(ms: number): void {
    if (this.timer.handle !== undefined) this.realClearTimeout(this.timer.handle)
    this.timer.active = true
    this.timer.handle = this.realSetTimeout(() => this.runTimers(), Math.max(1, ms))
  }

  toggleTimerRef(refed: boolean): void {
    this.timer.refed = refed
    this.queueAliveCheck()
  }

  private runTimers(): void {
    this.timer.active = false
    this.timer.handle = undefined
    const next = this.callback(() => this.processTimers?.(this.now())) ?? 0
    if (next !== 0) {
      const duration = Math.abs(next) - this.now()
      this.scheduleTimer(duration > 0 ? duration : 1)
      this.timer.refed = next > 0
    }
    this.queueAliveCheck()
  }

  // --- setImmediate -----------------------------------------------------------------------------

  private queueImmediates(): void {
    if (this.immediatesQueued || this.immediateInfo[kCount] === 0) return
    this.immediatesQueued = true
    // Not macrotask(): unreferenced immediates don't keep the loop alive.
    this.defer(() =>
      this.callback(() => {
        this.immediatesQueued = false
        if (this.immediateInfo[kCount] > 0) this.processImmediate?.()
        this.queueImmediates()
      }),
    )
  }

  // --- exit -------------------------------------------------------------------------------------

  queueAliveCheck(): void {
    if (this.aliveCheckQueued || this.exiting) return
    this.aliveCheckQueued = true
    // A macrotask (not a microtask) so pending promise reactions get to schedule work first. Not
    // setTimeout: browsers clamp nested timers, and throttle them to 1 s in background tabs.
    this.defer(() => {
      this.aliveCheckQueued = false
      if (this.isAlive() || this.exiting) return
      this.callback(() => this.emit?.('beforeExit', this.exitCode(0)))
      this.defer(() => {
        if (this.isAlive()) this.queueAliveCheck()
        else this.exitNaturally()
      })
    })
  }

  exitCode(fallback: number): number {
    return this.exitInfo[kHasExitCode] ? this.exitInfo[kExitCode] : fallback
  }

  /** EmitProcessExitInternal, then exit. */
  exitNaturally(): never {
    this.exiting = true
    this.exitInfo[kExiting] = 1
    const code = this.exitCode(0)
    this.callback(() => this.emit?.('exit', code))
    return this.reallyExit(this.exitCode(code))
  }

  reallyExit(code: number): never {
    this.exiting = true
    this.onExit?.(code)
    return this.sys.exit(code)
  }

  /** Proxies a typed array so that writes from JavaScript can be observed. */
  private watch<T extends Uint8Array | Uint32Array>(array: T, onWrite: () => void): T {
    return new Proxy(array, {
      set(target, property, value) {
        ;(target as unknown as Indexed)[property as unknown as number] = value
        onWrite()
        return true
      },
      get(target, property) {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
}
