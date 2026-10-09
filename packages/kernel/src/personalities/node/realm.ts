// The part of Node that lives in C++ around the JavaScript bootstrap: the process object,
// primordials, private symbols, builtin compilation and the bootstrap order
// (src/node_realm.cc, src/api/environment.cc, src/node_builtins.cc, src/builtin_info.h).
import type { BootMessage } from '../../abi/protocol.ts'
import type { SyscallName } from '../../abi/syscalls.ts'
import type { Platform } from '../../process/main.ts'
import type { SyscallClient } from '../../process/syscalls.ts'
import { createBindings, type BindingFactory } from './bindings/index.ts'
import type { Streams } from './bindings/streams.ts'
import { selectMainScript, type CommandLine } from './cli.ts'
import { isTerminal } from './bindings/streams.ts'
import { compileFunction, compiledScripts } from './compile.ts'
import { kEvaluationPhase, type Acorn } from './esm/transform.ts'
import type { NodeLib } from './lib.ts'
import { UvLoop } from './loop.ts'
import { VERSIONS } from './versions.ts'
import { BindingTrace } from './trace.ts'
import { host } from './host.ts'

const PARAMETERS = {
  realm: ['process', 'getLinkedBinding', 'getInternalBinding', 'primordials'],
  script: ['process', 'require', 'internalBinding', 'primordials'],
  perContext: ['exports', 'primordials', 'privateSymbols', 'perIsolateSymbols'],
  function: ['exports', 'require', 'module', 'process', 'internalBinding', 'primordials'],
}

function parametersFor(id: string): string[] {
  if (id.startsWith('internal/bootstrap/realm')) return PARAMETERS.realm
  if (id.startsWith('internal/bootstrap/') || id.startsWith('internal/main/')) return PARAMETERS.script
  if (id.startsWith('internal/per_context/')) return PARAMETERS.perContext
  return PARAMETERS.function
}

// PER_ISOLATE_PRIVATE_SYMBOL_PROPERTIES and PER_ISOLATE_SYMBOL_PROPERTIES (src/env_properties.h).
// V8 private symbols are invisible to reflection; ordinary symbols are the closest JS has.
const PRIVATE_SYMBOLS = [
  'arrow_message_private_symbol',
  'contextify_context_private_symbol',
  'decorated_private_symbol',
  'empty_context_frame_sentinel_symbol',
  'transfer_mode_private_symbol',
  'host_defined_option_symbol',
  'js_transferable_wrapper_private_symbol',
  'entry_point_module_private_symbol',
  'entry_point_promise_private_symbol',
  'module_source_private_symbol',
  'module_export_names_private_symbol',
  'module_circular_visited_private_symbol',
  'module_export_private_symbol',
  'module_first_parent_private_symbol',
  'module_last_parent_private_symbol',
  'napi_type_tag',
  'napi_wrapper',
  'untransferable_object_private_symbol',
  'exit_info_private_symbol',
  'promise_trace_id',
  'source_map_data_private_symbol',
]

// Keyed by description: internalBinding('symbols') exposes `oninit`, not `oninit_symbol`.
const PER_ISOLATE_SYMBOLS = [
  'fs_use_promises_symbol',
  'async_id_symbol',
  'constructor_key_symbol',
  'handle_onclose',
  'no_message_symbol',
  'messaging_deserialize_symbol',
  'imported_cjs_symbol',
  'messaging_transfer_symbol',
  'messaging_clone_symbol',
  'messaging_transfer_list_symbol',
  'oninit',
  'owner_symbol',
  'onpskexchange',
  'resource_symbol',
  'trigger_async_id_symbol',
  'builtin_source_text_module_hdo',
  'source_text_module_default_hdo',
  'vm_context_no_contextify',
  'vm_dynamic_import_default_internal',
  'vm_dynamic_import_main_context_default',
  'vm_dynamic_import_missing_flag',
  'vm_dynamic_import_no_callback',
]

export interface RealmInit {
  boot: BootMessage
  sys: SyscallClient
  platform: Platform
  lib: NodeLib
  commandLine: CommandLine
}

type AnyFunction = (...args: unknown[]) => unknown

export class Realm {
  readonly boot: BootMessage
  readonly sys: SyscallClient
  readonly platform: Platform
  readonly lib: NodeLib
  readonly commandLine: CommandLine
  readonly loop: UvLoop
  readonly trace = new BindingTrace()
  readonly primordials: Record<string, unknown> = Object.create(null)
  readonly privateSymbols: Record<string, symbol> = {}
  readonly perIsolateSymbols: Record<string, symbol> = {}
  /** Filled by internal/per_context/* scripts; read by bindings (e.g. messaging's DOMException). */
  readonly perContextExports: Record<string, unknown> = {}
  readonly process: Record<string | symbol, unknown>
  /** Set by internalBinding('builtins').setInternalLoaders during realm bootstrap. */
  internalBinding!: (name: string) => Record<string, unknown>
  requireBuiltin!: (id: string) => unknown
  /** Set by internalBinding('errors'). */
  enhanceStack?: { beforeInspector(error: unknown): string; afterInspector(error: unknown): string }
  /** Buffer.prototype, registered by internalBinding('buffer').setBufferPrototype. */
  bufferPrototype?: object
  /** Handle classes shared by stream_wrap, pipe_wrap, tcp_wrap, tty_wrap and process_wrap. */
  streams?: Streams
  /** Set by module_wrap.setImportModuleDynamicallyCallback / setInitializeImportMetaObjectCallback. */
  importModuleDynamicallyCallback?: (referrer: unknown, specifier: string, phase: number, attributes: object, referrerName: string) => Promise<unknown>
  initializeImportMetaCallback?: (referrer: unknown, meta: object, wrap: object) => void
  private acornModule?: Acorn
  private readonly importReferrers: [referrer: unknown, referrerName: string][] = []
  /**
   * The host's own web platform classes, captured before bootstrap installs Node's globals over
   * them. Overrides such as internal/deps/undici/undici re-export these.
   */
  readonly hostGlobals: Record<string, unknown>

  /** Process-wide worker_threads ids, shared by every thread (Atomics.add). */
  readonly threadIdCounter: Int32Array
  /** Run when the process exits, before the kernel tears it down (libuv's uv_tty_reset_mode). */
  readonly atExit = new Set<() => void>()

  private readonly factories: Record<string, BindingFactory>
  private readonly bindingCache = new Map<string, object>()

  constructor(init: RealmInit) {
    this.boot = init.boot
    this.sys = init.sys
    this.platform = init.platform
    this.lib = init.lib
    this.commandLine = init.commandLine
    this.loop = new UvLoop(init.sys)
    for (const name of PRIVATE_SYMBOLS) this.privateSymbols[name] = Symbol(`node:${name}`)
    for (const name of PER_ISOLATE_SYMBOLS) this.perIsolateSymbols[name] = Symbol(name)
    this.factories = createBindings()
    this.hostGlobals = captureHostGlobals(this.loop)
    hideHostOnlyGlobals()
    this.threadIdCounter =
      (init.boot.thread?.options.threadIdCounter as Int32Array | undefined) ?? new Int32Array(new SharedArrayBuffer(4))
    this.process = this.createProcessObject()
    this.loop.process = this.process
  }

  /** getInternalBinding(): our TypeScript implementation of a C++ binding, or a tracing stub. */
  getInternalBinding = (name: string): object => {
    let binding = this.bindingCache.get(name)
    if (!binding) {
      const factory = this.factories[name]
      binding = factory ? this.trace.wrap(name, factory(this)) : this.trace.missingBinding(name)
      this.bindingCache.set(name, binding)
    }
    return binding
  }

  /** Whether `arg` is a Node option (for worker execArgv validation). V8 flags are accepted too. */
  isKnownOption(arg: string): boolean {
    const name = arg.split('=')[0]
    return name in this.lib.options || /^--(max-old-space-size|max-semi-space-size|stack-size|expose-gc|harmony|jitless|no-)/.test(name)
  }

  /** process.env is a Proxy, which structured clone can't copy (messaging sends a plain copy). */
  isEnvProxy(value: unknown): boolean {
    return typeof value === 'object' && value !== null && envProxies.has(value)
  }

  /** Node's bundled acorn, used to compile ES modules and to find import() in scripts. */
  get acorn(): Acorn {
    return (this.acornModule ??= this.requireBuiltin('internal/deps/acorn/acorn/dist/acorn') as Acorn)
  }

  /** V8's HostImportModuleDynamically: hands import() to Node's loader. */
  dynamicImport(referrer: unknown, specifier: unknown, options: unknown, referrerName: string): Promise<unknown> {
    const callback = this.importModuleDynamicallyCallback
    if (!callback) return Promise.reject(new Error('import() is not available'))
    const attributes = (options as { with?: object } | undefined)?.with ?? {}
    try {
      return callback(referrer, String(specifier), kEvaluationPhase, attributes, referrerName)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * Scripts and CommonJS reach the loader through a global dispatcher, because their import()
   * expressions can't see a local binding. Returns the replacement for `import(`.
   */
  importCallFor(referrer: unknown, referrerName: string): string {
    this.importReferrers.push([referrer, referrerName])
    return `${IMPORT_DISPATCHER}(${this.importReferrers.length - 1}, `
  }

  /** Turns bytes into a Buffer, as C++ does by giving a Uint8Array Buffer.prototype. */
  newBuffer(bytes: Uint8Array): Uint8Array {
    return this.bufferPrototype ? Object.setPrototypeOf(bytes, this.bufferPrototype) : bytes
  }

  /** BuiltinLoader::LookupAndCompile: the module source becomes a function body. */
  compile(id: string): AnyFunction {
    try {
      return compileFunction(parametersFor(id), this.lib.source(id), `node:${id}`)
    } catch (error) {
      if (error instanceof Error) error.message = `${error.message} (compiling node:${id})`
      throw error
    }
  }

  /** Realm::RunBootstrapping + PrincipalRealm::BootstrapRealm. */
  bootstrap(): void {
    const { primordials } = this
    this.perContextExports.primordials = primordials
    for (const id of [
      'internal/per_context/primordials',
      'internal/per_context/domexception',
      'internal/per_context/messageport',
    ]) {
      this.compile(id)(this.perContextExports, primordials, this.privateSymbols, this.perIsolateSymbols)
    }

    const getLinkedBinding = (name: string) => {
      throw new Error(`No such binding: ${name}`)
    }
    this.compile('internal/bootstrap/realm')(this.process, getLinkedBinding, this.getInternalBinding, primordials)

    for (const id of [
      'internal/bootstrap/node',
      'internal/bootstrap/web/exposed-wildcard',
      'internal/bootstrap/web/exposed-window-or-worker',
      ...(this.boot.thread
        ? ['internal/bootstrap/switches/is_not_main_thread', 'internal/bootstrap/switches/does_not_own_process_state']
        : ['internal/bootstrap/switches/is_main_thread', 'internal/bootstrap/switches/does_own_process_state']),
    ]) {
      this.compile(id)(this.process, this.requireBuiltin, this.internalBinding, primordials)
    }
    this.process.env = createEnvProxy(this.boot.env)
    Object.defineProperty(globalThis, IMPORT_DISPATCHER, {
      value: (id: number, specifier: unknown, options: unknown) => {
        const [referrer, referrerName] = this.importReferrers[id]
        return this.dynamicImport(referrer, specifier, options, referrerName)
      },
    })
    this.loop.emit = (name, ...args) => {
      const emit = this.process.emit
      if (typeof emit === 'function') emit.call(this.process, name, ...args)
    }
    hideHostFrames()
  }

  /** StartExecution: runs one internal/main/* script inside a callback scope. */
  runMain(): void {
    // A worker_threads thread waits for its script on the env port (internal/main/worker_thread).
    const id = this.boot.thread ? 'internal/main/worker_thread' : selectMainScript(this.commandLine, () => isTerminal(this, 0))
    this.loop.callback(() => this.compile(id)(this.process, this.requireBuiltin, this.internalBinding, this.primordials))
    this.loop.queueAliveCheck()
  }

  /** CreateProcessObject (src/node_process_object.cc). */
  private createProcessObject(): Record<string | symbol, unknown> {
    const ProcessConstructor = function process() {} as unknown as new () => Record<string | symbol, unknown>
    const process = new ProcessConstructor()
    process[this.privateSymbols.exit_info_private_symbol] = this.loop.exitInfo
    const readonly = (target: object, key: string, value: unknown) =>
      Object.defineProperty(target, key, { value, writable: false, enumerable: true, configurable: true })
    readonly(process, 'version', `v${VERSIONS.node}`)
    const versions = {}
    for (const [key, value] of Object.entries(VERSIONS)) readonly(versions, key, value)
    readonly(process, 'versions', versions)
    readonly(process, 'arch', 'wasm32')
    readonly(process, 'platform', 'linux')
    const release = {}
    readonly(release, 'name', 'node')
    readonly(release, 'lts', 'Krypton')
    readonly(process, 'release', release)
    const encoder = new host.TextEncoder()
    process._rawDebug = (message: unknown) => this.sys.call('write', 2, encoder.encode(`${String(message)}\n`))
    // The kernel ABI, for webcore's own JavaScript programs (sh, npm). Not enumerable, so Node code
    // inspecting `process` sees what it expects.
    const sys = this.sys
    Object.defineProperty(process, 'webcore', {
      value: Object.freeze({
        syscall: (name: SyscallName, ...args: unknown[]) => sys.call(name, ...(args as never)),
        syscallAsync: (name: SyscallName, ...args: unknown[]) => this.loop.track(sys.callAsync(name, ...(args as never))),
      }),
      enumerable: false,
    })
    return process
  }
}

// Globals a Node process has (Node 24's own, plus ECMAScript's). Everything else a Worker offers
// (self, importScripts, postMessage, XMLHttpRequest, addEventListener, location, …) is hidden:
// code that sees them concludes it runs in a browser, and picks browser code paths.
const NODE_GLOBALS = new Set(
  (
    'AbortController AbortSignal AggregateError Array ArrayBuffer AsyncDisposableStack Atomics BigInt BigInt64Array ' +
    'BigUint64Array Blob Boolean BroadcastChannel Buffer ByteLengthQueuingStrategy CloseEvent CompressionStream ' +
    'CountQueuingStrategy Crypto CryptoKey CustomEvent DOMException DataView Date DecompressionStream DisposableStack ' +
    'Error EvalError Event EventTarget File FinalizationRegistry Float16Array Float32Array Float64Array FormData ' +
    'Function Headers Infinity Int16Array Int32Array Int8Array Intl Iterator JSON Map Math MessageChannel ' +
    'MessageEvent MessagePort NaN Navigator Number Object Performance PerformanceEntry PerformanceMark ' +
    'PerformanceMeasure PerformanceObserver PerformanceObserverEntryList PerformanceResourceTiming Promise Proxy ' +
    'RangeError ReadableByteStreamController ReadableStream ReadableStreamBYOBReader ReadableStreamBYOBRequest ' +
    'ReadableStreamDefaultController ReadableStreamDefaultReader ReferenceError Reflect RegExp Request Response Set ' +
    'SharedArrayBuffer String SubtleCrypto SuppressedError Symbol SyntaxError TextDecoder TextDecoderStream ' +
    'TextEncoder TextEncoderStream TransformStream TransformStreamDefaultController TypeError URIError URL ' +
    'URLPattern URLSearchParams Uint16Array Uint32Array Uint8Array Uint8ClampedArray WeakMap WeakRef WeakSet ' +
    'WebAssembly WebSocket WritableStream WritableStreamDefaultController WritableStreamDefaultWriter atob btoa ' +
    'clearImmediate clearInterval clearTimeout console constructor crypto decodeURI decodeURIComponent encodeURI ' +
    'encodeURIComponent escape eval fetch global globalThis isFinite isNaN navigator parseFloat parseInt ' +
    'performance process queueMicrotask setImmediate setInterval setTimeout structuredClone undefined unescape ' +
    'Temporal ShadowRealm'
  ).split(' '),
)

function hideHostOnlyGlobals(): void {
  const global = globalThis as unknown as Record<string, unknown>
  const names = new Set<string>()
  for (let object: object | null = globalThis; object && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
    for (const name of Object.getOwnPropertyNames(object)) names.add(name)
  }
  for (const name of names) {
    if (NODE_GLOBALS.has(name) || name.startsWith('__webcore')) continue
    try {
      delete global[name]
    } catch {
      // Not configurable.
    }
    // Inherited (from WorkerGlobalScope or EventTarget): shadow it rather than touch shared prototypes.
    if (name in globalThis) {
      try {
        Object.defineProperty(globalThis, name, { value: undefined, writable: true, configurable: true, enumerable: false })
      } catch {
        // Leave it.
      }
    }
  }
}

/** Global used by import() in scripts and CommonJS (see Realm.importCallFor). */
const IMPORT_DISPATCHER = '__webcore_import'

const HOST_GLOBALS = [
  'fetch', 'FormData', 'Headers', 'Request', 'Response', 'WebSocket', 'EventSource', 'MessageEvent',
  'CloseEvent', 'URLPattern',
]

function captureHostGlobals(loop: UvLoop): Record<string, unknown> {
  const host = globalThis as unknown as Record<string, unknown>
  const globals = Object.fromEntries(HOST_GLOBALS.map((name) => [name, host[name]]))
  // A pending request keeps a Node process alive (undici's sockets do in real Node). The host's
  // fetch settles outside the event loop's view, so the loop is told about it and about body reads.
  const fetch = globals.fetch as typeof globalThis.fetch | undefined
  if (fetch) globals.fetch = (...args: Parameters<typeof globalThis.fetch>) => loop.track(fetch(...args))
  const trackMethods = (proto: object | undefined, names: string[]) => {
    for (const name of names) {
      const original = proto && (proto as Record<string, unknown>)[name]
      if (typeof original !== 'function') continue
      Object.defineProperty(proto, name, {
        value: function (this: unknown, ...args: unknown[]) {
          return loop.track(original.apply(this, args) as Promise<unknown>)
        },
        writable: true,
        configurable: true,
      })
    }
  }
  const BODY_METHODS = ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']
  trackMethods((globals.Response as { prototype?: object } | undefined)?.prototype, BODY_METHODS)
  trackMethods((globals.Request as { prototype?: object } | undefined)?.prototype, BODY_METHODS)
  trackMethods((host.ReadableStreamDefaultReader as { prototype?: object } | undefined)?.prototype, ['read'])
  // V8 compiles on background threads and Node's platform keeps the loop alive meanwhile.
  trackMethods(host.WebAssembly as object | undefined, ['compile', 'instantiate', 'compileStreaming', 'instantiateStreaming'])
  return globals
}

/**
 * Stack traces come from Node's own formatter (V8 honours Error.prepareStackTrace). Frames from
 * webcore's own implementation are dropped: any URL script we didn't compile ourselves (Node's
 * builtins are node: URLs, user code has file paths or file: URLs), plus generator plumbing.
 */
function hideHostFrames(): void {
  const format = Error.prepareStackTrace
  if (typeof format !== 'function') return
  // Code compiled from source text reports its sourceURL only through getScriptNameOrSourceURL.
  const scriptOf = (frame: NodeJS.CallSite) => frame.getScriptNameOrSourceURL?.() ?? frame.getFileName() ?? ''
  const isHostFrame = (frame: NodeJS.CallSite) => {
    const script = scriptOf(frame)
    if (/^(https?|file|blob):/.test(script)) return !compiledScripts.has(script)
    if (script !== '') return false
    return frame.isEval() || frame.getFunctionName() === 'eval' || /^(Async)?Generator$/.test(frame.getTypeName() ?? '')
  }
  // V8 labels anonymous functions in source-compiled code "eval"; Node prints the bare location.
  const relabel = (frame: NodeJS.CallSite): NodeJS.CallSite => {
    const text = String(frame)
    if (!frame.isEval() || !text.startsWith('eval (')) return frame
    const location = text.slice('eval ('.length, -1)
    return new Proxy(frame, {
      get: (target, key) => {
        if (key === 'toString') return () => location
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  Error.prepareStackTrace = function prepareStackTrace(error, frames) {
    return format.call(this, error, frames.filter((frame) => !isHostFrame(frame)).map(relabel))
  }
}

/** process.env (src/node_env_var.cc): values are coerced to strings; symbols are rejected. */
const envProxies = new WeakSet<object>()

function createEnvProxy(initial: Record<string, string>): Record<string, string> {
  const store: Record<string, string> = Object.create(null)
  Object.assign(store, initial)
  const proxy = new Proxy(store, {
    set(target, key, value) {
      if (typeof key === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string')
      target[key] = String(value)
      return true
    },
    defineProperty(target, key, descriptor) {
      if (typeof key === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string')
      if ('value' in descriptor) target[key] = String(descriptor.value)
      return true
    },
    getOwnPropertyDescriptor(target, key) {
      if (typeof key === 'symbol' || !(key in target)) return undefined
      return { value: target[key], writable: true, enumerable: true, configurable: true }
    },
  })
  envProxies.add(proxy)
  return proxy
}
