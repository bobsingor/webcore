// Event-loop liveness, the way Node decides when to exit: a process stays alive while it has
// referenced handles (timers, stdin reads, in-flight async syscalls). When the count reaches zero
// and the macrotask queue has drained, the process exits.

export class EventLoop {
  private refs = 0
  private checkScheduled = false
  private readonly onIdle: () => void
  private readonly realSetTimeout = globalThis.setTimeout.bind(globalThis)
  private readonly realClearTimeout = globalThis.clearTimeout.bind(globalThis)
  private readonly realSetInterval = globalThis.setInterval.bind(globalThis)
  private readonly realClearInterval = globalThis.clearInterval.bind(globalThis)
  private readonly timers = new Map<number, Timeout>()

  constructor(onIdle: () => void) {
    this.onIdle = onIdle
  }

  get isIdle(): boolean {
    return this.refs <= 0
  }

  ref(): void {
    this.refs++
  }

  unref(): void {
    this.refs--
    this.check()
  }

  /** Keeps the process alive until `promise` settles. */
  track<T>(promise: Promise<T>): Promise<T> {
    this.ref()
    return promise.finally(() => this.unref())
  }

  check(): void {
    if (this.refs > 0 || this.checkScheduled) return
    this.checkScheduled = true
    this.realSetTimeout(() => {
      this.checkScheduled = false
      if (this.refs <= 0) this.onIdle()
    }, 0)
  }

  /** Node-flavoured timer globals backed by the real ones. */
  timerGlobals() {
    const schedule = (repeat: boolean, callback: (...args: unknown[]) => void, ms = 0, args: unknown[] = []) => {
      const timer = new Timeout(this, repeat)
      const run = () => {
        if (!repeat) this.finish(timer)
        callback(...args)
      }
      timer.id = Number(repeat ? this.realSetInterval(run, ms) : this.realSetTimeout(run, ms))
      this.timers.set(timer.id, timer)
      this.ref()
      return timer
    }
    const clear = (handle: unknown) => {
      const timer = handle instanceof Timeout ? handle : this.timers.get(Number(handle))
      if (!timer?.active) return
      if (timer.repeat) this.realClearInterval(timer.id)
      else this.realClearTimeout(timer.id)
      this.finish(timer)
    }
    return {
      setTimeout: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
        schedule(false, callback, ms, args),
      setInterval: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
        schedule(true, callback, ms, args),
      setImmediate: (callback: (...args: unknown[]) => void, ...args: unknown[]) => schedule(false, callback, 0, args),
      clearTimeout: clear,
      clearInterval: clear,
      clearImmediate: clear,
    }
  }

  private finish(timer: Timeout): void {
    timer.active = false
    this.timers.delete(timer.id)
    if (timer.refed) this.unref()
  }
}

export class Timeout {
  id = 0
  active = true
  refed = true
  readonly repeat: boolean
  private readonly loop: EventLoop

  constructor(loop: EventLoop, repeat: boolean) {
    this.loop = loop
    this.repeat = repeat
  }

  ref(): this {
    if (!this.refed && this.active) {
      this.refed = true
      this.loop.ref()
    }
    return this
  }

  unref(): this {
    if (this.refed && this.active) {
      this.refed = false
      this.loop.unref()
    }
    return this
  }

  hasRef(): boolean {
    return this.refed
  }

  refresh(): this {
    return this
  }

  [Symbol.toPrimitive](): number {
    return this.id
  }
}
