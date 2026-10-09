// Minimal Node EventEmitter. Listener storage is created lazily so objects built with
// Object.create(EventEmitter.prototype) still work.
type Listener = ((...args: any[]) => void) & { listener?: Listener }

const kEvents = Symbol('events')

export class EventEmitter {
  static defaultMaxListeners = 10
  declare [kEvents]?: Map<string | symbol, Listener[]>

  static once(emitter: EventEmitter, name: string | symbol): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const onError = (error: unknown) => {
        emitter.off(name, onEvent)
        reject(error)
      }
      const onEvent = (...args: unknown[]) => {
        if (name !== 'error') emitter.off('error', onError)
        resolve(args)
      }
      emitter.once(name, onEvent)
      if (name !== 'error') emitter.once('error', onError)
    })
  }

  private events(): Map<string | symbol, Listener[]> {
    return (this[kEvents] ??= new Map())
  }

  on(name: string | symbol, listener: Listener): this {
    const list = this.events().get(name)
    if (list) list.push(listener)
    else this.events().set(name, [listener])
    return this
  }

  addListener(name: string | symbol, listener: Listener): this {
    return this.on(name, listener)
  }

  prependListener(name: string | symbol, listener: Listener): this {
    this.events().set(name, [listener, ...(this.events().get(name) ?? [])])
    return this
  }

  once(name: string | symbol, listener: Listener): this {
    return this.on(name, this.onceWrapper(name, listener))
  }

  prependOnceListener(name: string | symbol, listener: Listener): this {
    return this.prependListener(name, this.onceWrapper(name, listener))
  }

  off(name: string | symbol, listener: Listener): this {
    const list = this.events().get(name)
    if (!list) return this
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === listener || list[i].listener === listener) {
        list.splice(i, 1)
        break
      }
    }
    if (!list.length) this.events().delete(name)
    return this
  }

  removeListener(name: string | symbol, listener: Listener): this {
    return this.off(name, listener)
  }

  removeAllListeners(name?: string | symbol): this {
    if (name === undefined) this.events().clear()
    else this.events().delete(name)
    return this
  }

  emit(name: string | symbol, ...args: unknown[]): boolean {
    const list = this.events().get(name)
    if (!list?.length) {
      if (name === 'error') {
        const error = args[0]
        throw error instanceof Error ? error : new Error(`Unhandled error. (${String(error)})`)
      }
      return false
    }
    for (const listener of [...list]) listener.apply(this, args)
    return true
  }

  listeners(name: string | symbol): Listener[] {
    return (this.events().get(name) ?? []).map((listener) => listener.listener ?? listener)
  }

  rawListeners(name: string | symbol): Listener[] {
    return [...(this.events().get(name) ?? [])]
  }

  listenerCount(name: string | symbol): number {
    return this.events().get(name)?.length ?? 0
  }

  eventNames(): (string | symbol)[] {
    return [...this.events().keys()]
  }

  setMaxListeners(_count: number): this {
    return this
  }

  getMaxListeners(): number {
    return EventEmitter.defaultMaxListeners
  }

  private onceWrapper(name: string | symbol, listener: Listener): Listener {
    const wrapper: Listener = (...args: unknown[]) => {
      this.off(name, wrapper)
      listener.apply(this, args)
    }
    wrapper.listener = listener
    return wrapper
  }
}

/** The `events` module: the EventEmitter constructor with its helpers attached. */
export function createEventsModule(): typeof EventEmitter & { EventEmitter: typeof EventEmitter } {
  return Object.assign(EventEmitter, { EventEmitter })
}
