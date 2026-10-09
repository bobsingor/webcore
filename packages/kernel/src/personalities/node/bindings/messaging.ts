// messaging (src/node_messaging.cc): Node's MessagePort and MessageChannel over the host's
// MessagePorts, so ports can cross Workers (worker_threads, ADR-0016).
//
// The host's structured clone does the copying. Node's own rules sit around it, in a codec:
// - Port wrappers become host ports.
// - JS transferables (`transfer_mode_private_symbol`) go through the kClone/kTransfer protocol.
// - Untransferable buffers (Node's Buffer pool) and unlisted transferables are refused with Node's
//   DataCloneError messages.
// - process.env (a Proxy) is sent as a plain object.
// Messages travel as { t: 'm', v, h }: the value with placeholder objects, and [placeholder,
// kind, payload] entries resolved on arrival. Placeholders keep their identity because they sit
// in one clone graph.
import { host } from '../host.ts'
import type { Realm } from '../realm.ts'

const kTransferable = 1
const kCloneable = 2

// Brand checks: Node's primordials SafeMap/SafeSet are real Maps and Sets whose prototype chain
// doesn't reach Map.prototype, so instanceof is false for them.
const mapHas = Map.prototype.has
const setHas = Set.prototype.has
const mapEntries = Map.prototype.entries
const setValues = Set.prototype.values
const mapSet = Map.prototype.set
const setAdd = Set.prototype.add
const setDelete = Set.prototype.delete

function isMap(value: object): value is Map<unknown, unknown> {
  try {
    mapHas.call(value, undefined)
    return true
  } catch {
    return false
  }
}

function isSet(value: object): value is Set<unknown> {
  try {
    setHas.call(value, undefined)
    return true
  } catch {
    return false
  }
}

interface HostPort {
  postMessage(message: unknown, transfer?: Transferable[]): void
  close(): void
  addEventListener(type: string, listener: (event: MessageEvent) => void): void
  start?(): void
}

interface PortState {
  host: HostPort
  queue: RawMessage[]
  receiving: boolean
  refed: boolean
  closing: boolean
  closed: boolean
  scheduled: boolean
  peerGone: boolean
  /** BroadcastChannels can't transfer. */
  broadcast: boolean
  /** Receives sentinels other than messages and closes (the worker's exit notice). */
  onControl?: (message: RawMessage) => void
  /** The other end, while both ends are in this thread: Node enqueues there synchronously. */
  peer?: object
  /** Which channel and end this is, across threads (MessageChannel ports only). */
  channel?: string
  side: number
  /** Messages posted by this end and arrived at it, over its lifetime (through transfers too). */
  sent: number
  received: number
}

/** A port's identity and counters, carried when it's transferred. */
interface PortIdentity {
  channel?: string
  side: number
  sent: number
  received: number
}

/** What a thread sent on each channel before it ended: [channel, side, sent]. */
export type SentCount = [channel: string, side: number, sent: number]

type Entry = [placeholder: object, kind: 'port' | 'clone' | 'transfer', payload: unknown]

export interface RawMessage {
  t: string
  v?: unknown
  h?: Entry[]
  [key: string]: unknown
}

export interface Messaging {
  /** Wraps a host port in a Node MessagePort (after io.js has rewired the prototype). */
  wrap(hostPort: HostPort, onControl?: (message: RawMessage) => void): object
  /** Sends a control message (not seen by JavaScript) on a wrapped port's host port. */
  sendControl(port: object, message: RawMessage): void
  /** Closes every port this realm still has open (thread exit). */
  closeAll(): void
  /** How many messages each open channel end has sent, for a thread's exit notice. */
  sentCounts(): SentCount[]
  /**
   * Calls `done` once this realm's ends of those channels have received what the other ends sent.
   * Node delivers everything a thread sent before 'exit'; host channels don't order each other.
   */
  whenReceived(counts: SentCount[], done: () => void): void
}

export function messagingBindings() {
  return {
    messaging: (realm: Realm) => createMessaging(realm).binding,
  }
}

/** One instance per realm: the worker binding uses the same ports. */
export function messagingOf(realm: Realm): Messaging {
  return createMessaging(realm).api
}

const instances = new WeakMap<Realm, ReturnType<typeof buildMessaging>>()

function createMessaging(realm: Realm) {
  let instance = instances.get(realm)
  if (!instance) {
    instance = buildMessaging(realm)
    instances.set(realm, instance)
  }
  return instance
}

function buildMessaging(realm: Realm) {
  const { loop } = realm
  const sym = realm.perIsolateSymbols
  const transferMode = realm.privateSymbols.transfer_mode_private_symbol
  const untransferable = realm.privateSymbols.untransferable_object_private_symbol
  const states = new WeakMap<object, PortState>()
  const live = new Set<object>()
  let createObject: ((info: string) => object) | undefined
  const channelPrefix = `${realm.boot.thread?.id ?? 0}.`
  let nextChannel = 0
  const arrivalWatchers = new Set<() => void>()

  const DOMException = () => realm.perContextExports.DOMException as new (message: string, name: string) => Error
  const dataCloneError = (message: string) => new (DOMException())(message, 'DataCloneError')
  const coded = (error: Error, code: string) => Object.assign(error, { code })

  // --- the MessagePort function --------------------------------------------------------------

  // One function per realm, constructed only internally: io.js rewires its prototype at load, and
  // ports must be created with the prototype as it is then.
  const MessagePort = function MessagePort() {
    throw coded(new TypeError('Constructor cannot be called'), 'ERR_CONSTRUCT_CALL_INVALID')
  } as unknown as { prototype: Record<string | symbol, unknown> }

  const stateOf = (port: unknown): PortState => {
    const state = typeof port === 'object' && port !== null ? states.get(port) : undefined
    if (!state) throw coded(new TypeError('The "port" argument must be a MessagePort instance'), 'ERR_INVALID_ARG_TYPE')
    return state
  }

  const setRef = (state: PortState, refed: boolean) => {
    if (state.closed || state.refed === refed) return
    state.refed = refed
    if (refed) loop.ref()
    else loop.unref()
  }

  const finishClose = (port: object, state: PortState) => {
    if (state.closed) return
    setRef(state, false)
    state.closed = true
    live.delete(port)
    loop.callback(() => (port as Record<symbol, (() => void) | undefined>)[sym.handle_onclose]?.call(port))
  }

  const closePort = (port: object, state: PortState, notifyPeer: boolean) => {
    if (state.closing || state.closed) return
    state.closing = true
    if (notifyPeer && !state.peerGone) {
      try {
        state.host.postMessage({ t: 'c' })
      } catch {
        // The peer's side is gone.
      }
    }
    state.host.close()
    loop.defer(() => finishClose(port, state))
  }

  /** Delivers queued messages: all of them when `force`, else while the port is receiving. */
  const deliver = (port: object, state: PortState, force: boolean, limit = Infinity): number => {
    let delivered = 0
    while (state.queue.length && delivered < limit) {
      const head = state.queue[0]
      if (head.t === 'c') {
        state.queue.shift()
        state.peerGone = true
        closePort(port, state, false)
        return delivered
      }
      if (!state.receiving && !force) return delivered
      state.queue.shift()
      delivered++
      let decoded: { value: unknown; ports: object[] | undefined }
      try {
        decoded = decode(head)
      } catch (error) {
        loop.callback(() => emit(port, error, undefined, 'messageerror'))
        continue
      }
      loop.callback(() => emit(port, decoded.value, decoded.ports, 'message'))
    }
    return delivered
  }

  const emit = (port: object, data: unknown, ports: object[] | undefined, type: string) => {
    const emitMessage = realm.perContextExports.emitMessage as (this: object, data: unknown, ports: unknown, type: string) => void
    emitMessage.call(port, data, ports, type)
  }

  const schedule = (port: object, state: PortState) => {
    if (state.scheduled || state.closed) return
    if (!state.queue.length || (!state.receiving && state.queue[0].t !== 'c')) return
    state.scheduled = true
    loop.defer(() => {
      state.scheduled = false
      deliver(port, state, false, Math.max(state.queue.length, 1000))
      schedule(port, state)
    })
  }

  const createPort = (hostPort: HostPort, queued: RawMessage[] = [], broadcast = false, identity?: PortIdentity): object => {
    const port = Object.create(MessagePort.prototype) as object
    const state: PortState = {
      host: hostPort,
      queue: [...queued],
      receiving: false,
      refed: true,
      closing: false,
      closed: false,
      scheduled: false,
      peerGone: false,
      broadcast,
      channel: identity?.channel,
      side: identity?.side ?? 0,
      sent: identity?.sent ?? 0,
      received: identity?.received ?? 0,
    }
    states.set(port, state)
    live.add(port)
    loop.ref()
    hostPort.addEventListener('message', (event) => {
      const message = event.data as RawMessage
      if (!message || typeof message.t !== 'string') return
      if (message.t !== 'm' && message.t !== 'c') {
        state.onControl?.(message)
        return
      }
      state.queue.push(message)
      if (message.t === 'm') arrived(state)
      schedule(port, state)
    })
    // A port whose other end is gone (a terminated thread) closes, where the host reports it.
    hostPort.addEventListener('close', () => {
      state.peerGone = true
      state.queue.push({ t: 'c' })
      schedule(port, state)
    })
    hostPort.start?.()
    ;(port as Record<symbol, (() => void) | undefined>)[sym.oninit]?.call(port)
    return port
  }

  const arrived = (state: PortState) => {
    state.received++
    for (const check of [...arrivalWatchers]) check()
  }

  Object.assign(MessagePort.prototype, {
    postMessage(this: object, ...args: unknown[]) {
      if (!args.length) throw coded(new TypeError('Not enough arguments to MessagePort.postMessage'), 'ERR_MISSING_ARGS')
      const state = stateOf(this)
      const transfer = transferList(args[1])
      if (state.broadcast && transfer.length) {
        // Node can't transfer to several destinations either.
        return undefined
      }
      const { message, hostTransfer, transferredPorts } = encode(args[0], transfer, this)
      if (state.closing || state.closed) return undefined
      if (state.peerGone) return false
      const peer = state.peer && states.get(state.peer)
      try {
        // A local peer receives the message now, so receiveMessageOnPort() sees it immediately.
        if (peer && !peer.closing && !peer.closed) {
          peer.queue.push(host.structuredClone(message, { transfer: hostTransfer }))
          arrived(peer)
          schedule(state.peer!, peer)
        } else state.host.postMessage(message, hostTransfer)
      } catch (error) {
        throw toNodeCloneError(error)
      }
      state.sent++
      for (const port of transferredPorts) {
        const transferred = states.get(port)!
        transferred.closing = true
        loop.defer(() => finishClose(port, transferred))
      }
      return true
    },
    start(this: object) {
      const state = stateOf(this)
      state.receiving = true
      schedule(this, state)
    },
    close(this: object) {
      const state = states.get(this)
      if (state) closePort(this, state, true)
    },
    ref(this: object) {
      const state = states.get(this)
      if (state) setRef(state, true)
    },
    unref(this: object) {
      const state = states.get(this)
      if (state) setRef(state, false)
    },
    hasRef(this: object) {
      const state = states.get(this)
      return state && !state.closed ? state.refed : undefined
    },
    getAsyncId() {
      return -1
    },
    getProviderType() {
      return 0
    },
  })

  // --- the codec -----------------------------------------------------------------------------

  function transferList(option: unknown): unknown[] {
    if (option === undefined || option === null) return []
    if (Array.isArray(option)) return option
    if (typeof option === 'object' && Symbol.iterator in (option as object)) return [...(option as Iterable<unknown>)]
    if (typeof option === 'object') {
      const nested = (option as { transfer?: unknown }).transfer
      if (nested === undefined || nested === null) return []
      if (typeof nested === 'object' && Symbol.iterator in (nested as object)) return [...(nested as Iterable<unknown>)]
      throw coded(new TypeError('Optional options.transfer argument must be an iterable'), 'ERR_INVALID_ARG_TYPE')
    }
    throw coded(new TypeError('Optional transferList argument must be an iterable'), 'ERR_INVALID_ARG_TYPE')
  }

  function toNodeCloneError(error: unknown): unknown {
    if (error instanceof Error && error.name === 'DataCloneError') {
      return dataCloneError(error.message.replace(/^Failed to execute '[^']+' on '[^']+': /, ''))
    }
    return error
  }

  const modeOf = (value: object): number | undefined => {
    const mode = (value as Record<symbol, unknown>)[transferMode]
    return typeof mode === 'number' ? mode : undefined
  }

  const isPlainContainer = (value: object) => {
    if (Array.isArray(value) || isMap(value) || isSet(value)) return true
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) return false
    if (value instanceof Date || value instanceof RegExp || value instanceof Error) return false
    if (typeof WebAssembly !== 'undefined' && (value instanceof WebAssembly.Module || value instanceof WebAssembly.Memory)) return false
    return typeof value !== 'function'
  }

  /** Whether `value` contains anything the codec must replace (the common case is no). */
  const needsWalk = (value: unknown, seen = new Set<object>()): boolean => {
    if (typeof value !== 'object' || value === null || seen.has(value)) return false
    seen.add(value)
    if (states.has(value) || modeOf(value) !== undefined || realm.isEnvProxy(value)) return true
    if (!isPlainContainer(value)) return false
    if (isMap(value)) {
      for (const [key, item] of mapEntries.call(value)) if (needsWalk(key, seen) || needsWalk(item, seen)) return true
      return false
    }
    if (isSet(value)) {
      for (const item of setValues.call(value)) if (needsWalk(item, seen)) return true
      return false
    }
    for (const key of Object.keys(value)) if (needsWalk((value as Record<string, unknown>)[key], seen)) return true
    return false
  }

  function encode(value: unknown, transfer: unknown[], source?: object) {
    // Transfer-list validation, in Node's order and with its messages.
    const hostTransfer: Transferable[] = []
    const listedPorts = new Set<object>()
    const listedObjects = new Set<object>()
    const buffers = new Set<ArrayBuffer>()
    for (const item of transfer) {
      if (typeof item !== 'object' || item === null) throw dataCloneError('Found invalid value in transferList.')
      if ((item as Record<symbol, unknown>)[untransferable]) throw dataCloneError('Cannot transfer object of unsupported type.')
      if (item instanceof ArrayBuffer) {
        if ((item as { detached?: boolean }).detached) throw dataCloneError('Cannot transfer object of unsupported type.')
        if (buffers.has(item)) throw dataCloneError('Transfer list contains duplicate ArrayBuffer')
        buffers.add(item)
        hostTransfer.push(item)
        continue
      }
      if (item === source) throw dataCloneError('Transfer list contains source port')
      const state = states.get(item)
      if (state) {
        if (state.closing || state.closed) throw dataCloneError('MessagePort in transfer list is already detached')
        if (listedPorts.has(item)) throw dataCloneError('Transfer list contains duplicate MessagePort')
        listedPorts.add(item)
        continue
      }
      const mode = modeOf(item)
      if (mode === undefined || !(mode & kTransferable)) throw dataCloneError('Found invalid value in transferList.')
      if (listedObjects.has(item)) throw dataCloneError(`Transfer list contains duplicate ${item.constructor?.name ?? 'object'}`)
      listedObjects.add(item)
    }

    const entries: Entry[] = []
    const transferredPorts: object[] = []
    const placeholders = new Map<object, object>()

    const replace = (item: object): object | undefined => {
      const existing = placeholders.get(item)
      if (existing) return existing
      const state = states.get(item)
      if (state) {
        if (!listedPorts.has(item)) throw dataCloneError('Object that needs transfer was found in message but not listed in transferList')
        const placeholder = {}
        placeholders.set(item, placeholder)
        // Messages already received but not yet delivered travel with the port.
        const queued = state.queue.splice(0)
        const identity: PortIdentity = { channel: state.channel, side: state.side, sent: state.sent, received: state.received }
        entries.push([placeholder, 'port', { port: state.host, queued, identity }])
        hostTransfer.push(state.host as unknown as Transferable)
        transferredPorts.push(item)
        return placeholder
      }
      const mode = modeOf(item)
      if (mode !== undefined) {
        const placeholder = {}
        placeholders.set(item, placeholder)
        if (mode & kTransferable && listedObjects.has(item)) {
          const result = (item as Record<symbol, () => { data: unknown; deserializeInfo: string }>)[sym.messaging_transfer_symbol]()
          entries.push([placeholder, 'transfer', { info: result.deserializeInfo, data: walk(result.data) }])
        } else if (mode & kTransferable && !(mode & kCloneable)) {
          throw dataCloneError('Object that needs transfer was found in message but not listed in transferList')
        } else if (mode & kCloneable) {
          const result = (item as Record<symbol, () => { data: unknown; deserializeInfo: string }>)[sym.messaging_clone_symbol]()
          entries.push([placeholder, 'clone', { info: result.deserializeInfo, data: walk(result.data) }])
        } else {
          throw dataCloneError('Cannot clone object of unsupported type.')
        }
        return placeholder
      }
      if (realm.isEnvProxy(item)) return { ...(item as Record<string, string>) }
      return undefined
    }

    const copies = new Map<object, unknown>()
    function walk(input: unknown): unknown {
      if (typeof input !== 'object' || input === null) return input
      const replaced = replace(input)
      if (replaced) return replaced
      if (!isPlainContainer(input)) return input
      const done = copies.get(input)
      if (done !== undefined) return done
      if (Array.isArray(input)) {
        const copy: unknown[] = []
        copies.set(input, copy)
        for (const item of input) copy.push(walk(item))
        return copy
      }
      if (isMap(input)) {
        const copy = new Map()
        copies.set(input, copy)
        for (const [key, item] of mapEntries.call(input)) copy.set(walk(key), walk(item))
        return copy
      }
      if (isSet(input)) {
        const copy = new Set()
        copies.set(input, copy)
        for (const item of setValues.call(input)) copy.add(walk(item))
        return copy
      }
      const copy: Record<string, unknown> = {}
      copies.set(input, copy)
      for (const key of Object.keys(input)) copy[key] = walk((input as Record<string, unknown>)[key])
      return copy
    }

    const v = needsWalk(value) || listedPorts.size || listedObjects.size ? walk(value) : value
    // Ports listed for transfer but not in the value still move (as in Node).
    for (const port of listedPorts) if (!placeholders.has(port)) replace(port)
    return { message: { t: 'm', v, h: entries } satisfies RawMessage, hostTransfer, transferredPorts }
  }

  function decode(message: RawMessage): { value: unknown; ports: object[] | undefined } {
    const entries = message.h ?? []
    if (!entries.length) return { value: message.v, ports: undefined }
    const resolved = new Map<object, object>()
    const ports: object[] = []
    const deserialize: [object, unknown][] = []
    for (const [placeholder, kind, payload] of entries) {
      if (kind === 'port') {
        const { port, queued, identity } = payload as { port: HostPort; queued: RawMessage[]; identity: PortIdentity }
        const wrapper = createPort(port, queued, false, identity)
        resolved.set(placeholder, wrapper)
        ports.push(wrapper)
      } else {
        const { info, data } = payload as { info: string; data: unknown }
        if (!createObject) throw new Error('No deserializer for transferred objects')
        const object = createObject(info)
        resolved.set(placeholder, object)
        deserialize.push([object, data])
      }
    }
    const seen = new Set<object>()
    const fill = (input: unknown): unknown => {
      if (typeof input !== 'object' || input === null) return input
      const target = resolved.get(input)
      if (target) return target
      if (seen.has(input) || !isPlainContainer(input)) return input
      seen.add(input)
      if (Array.isArray(input)) for (let i = 0; i < input.length; i++) input[i] = fill(input[i])
      else if (isMap(input)) for (const [key, item] of [...mapEntries.call(input)]) mapSet.call(input, key, fill(item))
      else if (isSet(input)) {
        for (const item of [...setValues.call(input)]) {
          const filled = fill(item)
          if (filled !== item) {
            setDelete.call(input, item)
            setAdd.call(input, filled)
          }
        }
      } else for (const key of Object.keys(input)) (input as Record<string, unknown>)[key] = fill((input as Record<string, unknown>)[key])
      return input
    }
    const value = fill(message.v)
    for (const [object, data] of deserialize) {
      ;(object as Record<symbol, (data: unknown) => void>)[sym.messaging_deserialize_symbol](fill(data))
    }
    return { value, ports: ports.length ? ports : undefined }
  }

  // --- the binding ---------------------------------------------------------------------------

  function MessageChannel(this: { port1?: object; port2?: object } | undefined) {
    if (!new.target) throw coded(new TypeError('Class constructor MessageChannel cannot be invoked without \'new\''), 'ERR_CONSTRUCT_CALL_REQUIRED')
    const channel = new host.MessageChannel()
    const id = `${channelPrefix}${nextChannel++}`
    const port1 = createPort(channel.port1, [], false, { channel: id, side: 0, sent: 0, received: 0 })
    const port2 = createPort(channel.port2, [], false, { channel: id, side: 1, sent: 0, received: 0 })
    states.get(port1)!.peer = port2
    states.get(port2)!.peer = port1
    this!.port1 = port1
    this!.port2 = port2
  }

  const binding = {
    MessagePort,
    MessageChannel,
    get DOMException() {
      return realm.perContextExports.DOMException
    },
    exposeLazyDOMExceptionProperty: (target: object) =>
      Object.defineProperty(target, 'DOMException', {
        configurable: true,
        enumerable: false,
        get: () => realm.perContextExports.DOMException,
        set(value) {
          Object.defineProperty(target, 'DOMException', { value, writable: true, configurable: true, enumerable: false })
        },
      }),
    structuredClone: (value: unknown, options?: { transfer?: unknown }) => {
      const { message, hostTransfer } = encode(value, transferList(options?.transfer ?? options))
      let cloned: RawMessage
      try {
        cloned = host.structuredClone(message, { transfer: hostTransfer })
      } catch (error) {
        throw toNodeCloneError(error)
      }
      return decode(cloned).value
    },
    stopMessagePort: (port: object) => {
      stateOf(port).receiving = false
    },
    drainMessagePort: (port: object) => {
      const state = states.get(port)
      if (state) deliver(port, state, true)
    },
    receiveMessageOnPort: (port: object) => {
      const state = states.get(port)
      if (!state || state.closed) return sym.no_message_symbol
      while (state.queue.length) {
        const head = state.queue.shift()!
        if (head.t === 'c') {
          state.peerGone = true
          closePort(port, state, false)
          return sym.no_message_symbol
        }
        return decode(head).value
      }
      return sym.no_message_symbol
    },
    moveMessagePortToContext: () => {
      throw new Error('vm contexts are not supported yet (webcore)')
    },
    setDeserializerCreateObjectFunction: (fn: (info: string) => object) => {
      createObject = fn
    },
    broadcastChannel: (name: string) => {
      const channel = new host.BroadcastChannel(`webcore:${realm.boot.pid}:${name}`) as unknown as HostPort
      return createPort(channel, [], true)
    },
  }

  const api: Messaging = {
    wrap: (hostPort, onControl) => {
      const port = createPort(hostPort)
      states.get(port)!.onControl = onControl
      return port
    },
    sendControl: (port, message) => stateOf(port).host.postMessage(message),
    closeAll: () => {
      for (const port of [...live]) closePort(port, states.get(port)!, true)
    },
    sentCounts: () => {
      const counts: SentCount[] = []
      for (const port of live) {
        const state = states.get(port)!
        if (state.channel !== undefined && state.sent) counts.push([state.channel, state.side, state.sent])
      }
      return counts
    },
    whenReceived: (counts, done) => {
      const waiting = () => {
        for (const [channel, side, sent] of counts) {
          for (const port of live) {
            const state = states.get(port)!
            if (state.channel === channel && state.side !== side && state.received < sent) return true
          }
        }
        return false
      }
      if (!waiting()) return done()
      // A safety net: a message can't arrive if this end was closed or moved meanwhile.
      const timer = host.setTimeout(finish, 1000)
      function check() {
        if (!waiting()) finish()
      }
      function finish() {
        if (!arrivalWatchers.delete(check)) return
        host.clearTimeout(timer)
        done()
      }
      arrivalWatchers.add(check)
    },
  }

  return { binding, api }
}
