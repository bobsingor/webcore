// Bindings that support the JavaScript runtime itself: builtins loading, errors, util, types,
// options, symbols, and diagnostics hooks that have no browser equivalent (inert here).
import type { Realm } from '../realm.ts'
import { VERSIONS } from '../versions.ts'
import { host } from '../host.ts'

const toString = (value: unknown) => Object.prototype.toString.call(value)

/** Runs a brand check: true when `check` accepts `value` without throwing. */
function brand(check: () => unknown): boolean {
  try {
    check()
    return true
  } catch {
    return false
  }
}

const getter = <T>(proto: T, key: keyof T) => Object.getOwnPropertyDescriptor(proto, key)!.get!
const arrayBufferByteLength = getter(ArrayBuffer.prototype, 'byteLength')
const sharedArrayBufferByteLength = getter(SharedArrayBuffer.prototype, 'byteLength')
const dataViewByteLength = getter(DataView.prototype, 'byteLength')

const isBoxed = (value: unknown, valueOf: () => unknown) =>
  typeof value === 'object' && value !== null && brand(() => valueOf.call(value))

export const types = {
  isExternal: () => false,
  isDate: (v: unknown) => typeof v === 'object' && v !== null && brand(() => Date.prototype.getTime.call(v)),
  isArgumentsObject: (v: unknown) => toString(v) === '[object Arguments]',
  isBigIntObject: (v: unknown) => isBoxed(v, BigInt.prototype.valueOf),
  isBooleanObject: (v: unknown) => isBoxed(v, Boolean.prototype.valueOf),
  isNumberObject: (v: unknown) => isBoxed(v, Number.prototype.valueOf),
  isStringObject: (v: unknown) => isBoxed(v, String.prototype.valueOf),
  isSymbolObject: (v: unknown) => isBoxed(v, Symbol.prototype.valueOf),
  isBoxedPrimitive: (v: unknown) =>
    isBoxed(v, Number.prototype.valueOf) ||
    isBoxed(v, String.prototype.valueOf) ||
    isBoxed(v, Boolean.prototype.valueOf) ||
    isBoxed(v, BigInt.prototype.valueOf) ||
    isBoxed(v, Symbol.prototype.valueOf),
  isNativeError: (v: unknown) =>
    typeof (Error as { isError?: (v: unknown) => boolean }).isError === 'function'
      ? (Error as unknown as { isError: (v: unknown) => boolean }).isError(v)
      : v instanceof Error || toString(v) === '[object Error]',
  isRegExp: (v: unknown) => typeof v === 'object' && v !== null && brand(() => getter(RegExp.prototype, 'flags').call(v)) && toString(v) === '[object RegExp]',
  isAsyncFunction: (v: unknown) => /^\[object Async(Generator)?Function\]$/.test(toString(v)),
  isGeneratorFunction: (v: unknown) => /^\[object (Async)?GeneratorFunction\]$/.test(toString(v)),
  isGeneratorObject: (v: unknown) => toString(v) === '[object Generator]',
  isPromise: (v: unknown) => v instanceof Promise || toString(v) === '[object Promise]',
  isMap: (v: unknown) => typeof v === 'object' && v !== null && brand(() => Map.prototype.has.call(v, undefined)),
  isSet: (v: unknown) => typeof v === 'object' && v !== null && brand(() => Set.prototype.has.call(v, undefined)),
  isMapIterator: (v: unknown) => toString(v) === '[object Map Iterator]',
  isSetIterator: (v: unknown) => toString(v) === '[object Set Iterator]',
  isWeakMap: (v: unknown) => typeof v === 'object' && v !== null && brand(() => WeakMap.prototype.has.call(v, {})),
  isWeakSet: (v: unknown) => typeof v === 'object' && v !== null && brand(() => WeakSet.prototype.has.call(v, {})),
  isArrayBuffer: (v: unknown) => typeof v === 'object' && v !== null && brand(() => arrayBufferByteLength.call(v)),
  isSharedArrayBuffer: (v: unknown) => typeof v === 'object' && v !== null && brand(() => sharedArrayBufferByteLength.call(v)),
  isAnyArrayBuffer: (v: unknown) => types.isArrayBuffer(v) || types.isSharedArrayBuffer(v),
  isDataView: (v: unknown) => typeof v === 'object' && v !== null && brand(() => dataViewByteLength.call(v)),
  isArrayBufferView: (v: unknown) => ArrayBuffer.isView(v),
  // Proxies are undetectable from JavaScript.
  isProxy: () => false,
  isModuleNamespaceObject: (v: unknown) =>
    typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === null && (v as Record<symbol, unknown>)[Symbol.toStringTag] === 'Module',
}

const PROPERTY_FILTER = { ALL_PROPERTIES: 0, ONLY_WRITABLE: 1, ONLY_ENUMERABLE: 2, ONLY_CONFIGURABLE: 4, SKIP_STRINGS: 8, SKIP_SYMBOLS: 16 }
const EXIT_CODES = {
  kNoFailure: 0,
  kGenericUserError: 1,
  kInternalJSParseError: 3,
  kInternalJSEvaluationFailure: 4,
  kV8FatalError: 5,
  kInvalidFatalExceptionMonkeyPatching: 6,
  kExceptionInFatalExceptionHandler: 7,
  kInvalidCommandLineArgument: 9,
  kBootstrapFailure: 10,
  kInvalidCommandLineArgument2: 12,
  kUnsettledTopLevelAwait: 13,
  kStartupSnapshotFailure: 14,
  kAbort: 134,
}

function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  const pattern = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*('(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`|[^#\r\n]*)/gm
  for (const [, key, raw] of content.matchAll(pattern)) {
    let value = raw.trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'" || quote === '`') && value.endsWith(quote)) {
      value = value.slice(1, -1)
      if (quote === '"') value = value.replace(/\\n/g, '\n')
    }
    out[key] = value
  }
  return out
}

export function supportBindings() {
  return {
    builtins: (realm: Realm) => {
      const internalPrefixes = ['internal/bootstrap/', 'internal/per_context/', 'internal/deps/', 'internal/main/']
      return {
        builtinIds: realm.lib.ids,
        get builtinCategories() {
          const cannotBeRequired = realm.lib.ids.filter((id) => internalPrefixes.some((prefix) => id.startsWith(prefix)))
          return { cannotBeRequired, canBeRequired: realm.lib.ids.filter((id) => !cannotBeRequired.includes(id)) }
        },
        get natives() {
          return Object.fromEntries(realm.lib.ids.map((id) => [id, realm.lib.source(id)]))
        },
        config: JSON.stringify({
          target_defaults: { default_configuration: 'Release' },
          variables: {
            napi_build_version: VERSIONS.napi,
            node_module_version: Number(VERSIONS.modules),
            node_shared_openssl: false,
            node_use_openssl: false,
            node_use_quic: false,
            v8_enable_i18n_support: 0,
            host_arch: 'wasm32',
            target_arch: 'wasm32',
          },
        }),
        compileFunction: (id: string) => realm.compile(id),
        hasCachedBuiltins: () => true,
        setInternalLoaders: (internalBinding: Realm['internalBinding'], requireBuiltin: Realm['requireBuiltin']) => {
          realm.internalBinding = internalBinding
          realm.requireBuiltin = requireBuiltin
        },
        getCacheUsage: () => ({ compiledWithCache: [], compiledWithoutCache: [], compiledInSnapshot: [] }),
        importBuiltinSourceTextModule: (id: string) => {
          throw new Error(`Built-in ES module ${id} is not supported`)
        },
      }
    },

    errors: (realm: Realm) => {
      const encoder = new host.TextEncoder()
      const report = (error: unknown) => {
        let text: string
        if (error !== null && typeof error === 'object' && realm.enhanceStack) {
          try {
            realm.enhanceStack.beforeInspector(error)
            text = realm.enhanceStack.afterInspector(error)
          } catch {
            text = String((error as Error).stack ?? error)
          }
        } else {
          text = `${String(error)}\n(Use \`node --trace-uncaught ...\` to show where the exception was thrown)`
        }
        realm.sys.call('write', 2, encoder.encode(`${text}\n\nNode.js v${VERSIONS.node}\n`))
      }
      // TriggerUncaughtException (src/node_errors.cc).
      const triggerUncaughtException = (error: unknown, fromPromise = false) => {
        const fatalException = realm.process._fatalException
        if (typeof fatalException !== 'function') {
          report(error)
          return realm.loop.reallyExit(EXIT_CODES.kInvalidFatalExceptionMonkeyPatching)
        }
        let handled: unknown
        try {
          handled = fatalException.call(realm.process, error, fromPromise)
        } catch (inner) {
          report(inner)
          return realm.loop.reallyExit(EXIT_CODES.kExceptionInFatalExceptionHandler)
        }
        if (handled !== false) return undefined
        report(error)
        return realm.loop.reallyExit(realm.loop.exitCode(EXIT_CODES.kGenericUserError))
      }
      realm.loop.onUncaught = triggerUncaughtException
      return {
        exitCodes: EXIT_CODES,
        triggerUncaughtException,
        noSideEffectsToString: (value: unknown) => {
          try {
            return String(value)
          } catch {
            return '[object]'
          }
        },
        setPrepareStackTraceCallback: () => {},
        setGetSourceMapErrorSource: () => {},
        setSourceMapsEnabled: () => {},
        setMaybeCacheGeneratedSourceMap: () => {},
        setEnhanceStackForFatalException: (beforeInspector: (e: unknown) => string, afterInspector: (e: unknown) => string) => {
          realm.enhanceStack = { beforeInspector, afterInspector }
        },
        getErrorSourcePositions: () => undefined,
      }
    },

    util: (realm: Realm) => ({
      constants: {
        kPending: 0,
        kFulfilled: 1,
        kRejected: 2,
        kExiting: 0,
        kExitCode: 1,
        kHasExitCode: 2,
        ...PROPERTY_FILTER,
        kDisallowCloneAndTransfer: 0,
        kTransferable: 1,
        kCloneable: 2,
      },
      propertyFilter: PROPERTY_FILTER,
      privateSymbols: realm.privateSymbols,
      shouldAbortOnUncaughtToggle: new Int32Array(1),
      constructSharedArrayBuffer: (length = 0) => new SharedArrayBuffer(length),
      // ['TCP', 'TTY', 'UDP', 'FILE', 'PIPE', 'UNKNOWN']; pipes are FILEs until pipe_wrap (M1c).
      guessHandleType: (fd: number) => {
        try {
          const { type } = realm.sys.call('fstat', fd)
          return type === 'dir' ? 5 : 3
        } catch {
          return 5
        }
      },
      defineLazyProperties: (target: object, id: string, keys: string[], enumerable = true) => {
        for (const key of keys) {
          const define = (value: unknown) =>
            Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable })
          Object.defineProperty(target, key, {
            configurable: true,
            enumerable,
            get() {
              const value = (realm.requireBuiltin(id) as Record<string, unknown>)[key]
              define(value)
              return value
            },
            set: define,
          })
        }
      },
      sleep: (ms: number) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
      },
      getOwnNonIndexProperties: (object: object, filter: number) =>
        Reflect.ownKeys(object).filter((key) => {
          if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1) return false
          if (filter & PROPERTY_FILTER.SKIP_SYMBOLS && typeof key === 'symbol') return false
          if (filter & PROPERTY_FILTER.SKIP_STRINGS && typeof key === 'string') return false
          if (filter & PROPERTY_FILTER.ONLY_ENUMERABLE && !Object.getOwnPropertyDescriptor(object, key)?.enumerable) return false
          return true
        }),
      // Promise state is not observable synchronously from JavaScript.
      getPromiseDetails: () => [0],
      getProxyDetails: () => undefined,
      // Iterator and weak-collection contents are not observable without consuming them.
      previewEntries: (_object: object, isIterator?: boolean) => (isIterator ? [[], false] : []),
      getConstructorName: (object: object) => {
        for (let proto = object; proto; proto = Object.getPrototypeOf(proto)) {
          const ctor = Object.getOwnPropertyDescriptor(proto, 'constructor')?.value
          if (typeof ctor === 'function' && ctor.name) return ctor.name
        }
        return 'Object'
      },
      getExternalValue: () => 0n,
      isConstructor: (fn: unknown) => {
        if (typeof fn !== 'function') return false
        try {
          Reflect.construct(String, [], fn)
          return true
        } catch {
          return false
        }
      },
      arrayBufferViewHasBuffer: () => true,
      isInsideNodeModules: () => /\/node_modules\//.test(new Error().stack?.split('\n').slice(3).join('\n') ?? ''),
      getCallerLocation: () => undefined,
      getCallSites: () => [],
      parseEnv: parseDotenv,
      markPromiseAsHandled: (promise: Promise<unknown>) => {
        promise.catch(() => {})
      },
    }),

    types: () => types,

    symbols: (realm: Realm) => realm.perIsolateSymbols,

    config: () => ({
      isDebugBuild: false,
      hasOpenSSL: true,
      openSSLIsBoringSSL: false,
      fipsMode: false,
      // No ICU binding yet: Node falls back to its JavaScript TextDecoder and punycode.
      hasIntl: false,
      hasSmallICU: false,
      hasTracing: false,
      hasNodeOptions: true,
      hasInspector: false,
      hasSQLite: false,
      noBrowserGlobals: false,
      bits: 64,
      getDefaultLocale: () => Intl.DateTimeFormat().resolvedOptions().locale,
    }),

    options: (realm: Realm) => ({
      getCLIOptionsValues: () => realm.commandLine.options,
      getCLIOptionsInfo: () => ({ options: new Map(), aliases: new Map() }),
      getOptionsAsFlags: () => [],
      getEmbedderOptions: () => ({
        shouldNotRegisterESMLoader: false,
        noGlobalSearchPaths: false,
        noBrowserGlobals: false,
        hasEmbedderPreload: false,
      }),
      getEnvOptionsInputType: () => new Map(),
      getNamespaceOptionsInputType: () => new Map(),
      envSettings: { kAllowedInEnvvar: 0, kDisallowedInEnvvar: 1 },
      types: { kNoOp: 0, kV8Option: 1, kBoolean: 2, kInteger: 3, kUInteger: 4, kString: 5, kHostPort: 6, kStringList: 7 },
      noGlobalSearchPaths: false,
      shouldNotRegisterESMLoader: false,
    }),

    worker: () => ({
      isMainThread: true,
      isInternalThread: false,
      ownsProcessState: true,
      threadId: 0,
      threadName: 'main',
      resourceLimits: new Float64Array(4),
      kMaxYoungGenerationSizeMb: 0,
      kMaxOldGenerationSizeMb: 1,
      kCodeRangeSizeMb: 2,
      kStackSizeMb: 3,
      kTotalResourceLimitCount: 4,
      getEnvMessagePort: () => undefined,
      Worker: class Worker {
        constructor() {
          throw new Error('worker_threads are not supported yet (webcore M1e)')
        }
      },
    }),

    messaging: (realm: Realm) => {
      // Node patches MessagePort.prototype, so these must be our own classes, never the host's.
      class MessagePort {
        postMessage() {}
        start() {}
        close() {}
        drain() {}
        ref() {}
        unref() {}
        hasRef() {
          return false
        }
      }
      class MessageChannel {
        port1 = new MessagePort()
        port2 = new MessagePort()
      }
      return {
        MessagePort,
        MessageChannel,
        JSTransferable: class JSTransferable {},
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
        structuredClone: (value: unknown, options?: StructuredSerializeOptions) => host.structuredClone(value, options),
        stopMessagePort: () => {},
        drainMessagePort: () => {},
        receiveMessageOnPort: () => undefined,
        moveMessagePortToContext: (port: MessagePort) => port,
        setDeserializerCreateObjectFunction: () => {},
        broadcastChannel: () => new MessagePort(),
      }
    },

    performance: (realm: Realm) => {
      const milestones = new Float64Array(8)
      const now = () => host.performance.now()
      return {
        constants: {
          NODE_PERFORMANCE_ENTRY_TYPE_GC: 0,
          NODE_PERFORMANCE_ENTRY_TYPE_HTTP: 1,
          NODE_PERFORMANCE_ENTRY_TYPE_HTTP2: 2,
          NODE_PERFORMANCE_ENTRY_TYPE_NET: 3,
          NODE_PERFORMANCE_ENTRY_TYPE_DNS: 4,
          NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN_TIMESTAMP: 0,
          NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN: 1,
          NODE_PERFORMANCE_MILESTONE_ENVIRONMENT: 2,
          NODE_PERFORMANCE_MILESTONE_NODE_START: 3,
          NODE_PERFORMANCE_MILESTONE_V8_START: 4,
          NODE_PERFORMANCE_MILESTONE_LOOP_START: 5,
          NODE_PERFORMANCE_MILESTONE_LOOP_EXIT: 6,
          NODE_PERFORMANCE_MILESTONE_BOOTSTRAP_COMPLETE: 7,
          NODE_PERFORMANCE_GC_MAJOR: 4,
          NODE_PERFORMANCE_GC_MINOR: 1,
          NODE_PERFORMANCE_GC_INCREMENTAL: 8,
          NODE_PERFORMANCE_GC_WEAKCB: 16,
          NODE_PERFORMANCE_GC_FLAGS_NO: 0,
          NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED: 2,
          NODE_PERFORMANCE_GC_FLAGS_FORCED: 4,
          NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING: 8,
          NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE: 16,
          NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY: 32,
          NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE: 64,
        },
        milestones,
        observerCounts: new Uint32Array(5),
        now,
        getTimeOrigin: () => 0,
        getTimeOriginTimestamp: () => host.performance.timeOrigin * 1000,
        markBootstrapComplete: () => {
          milestones[7] = now() * 1e6
        },
        loopIdleTime: () => 0,
        installGarbageCollectionTracking: () => {},
        removeGarbageCollectionTracking: () => {},
        notify: () => {},
        setupObservers: () => {},
        uvMetricsInfo: () => [realm.loop.now(), 0, 0],
      }
    },

    // Diagnostics with no browser equivalent: inert but well-formed.
    trace_events: () => ({
      trace: () => {},
      isTraceCategoryEnabled: () => false,
      getCategoryEnabledBuffer: () => new Uint8Array(1),
      setTraceCategoryStateUpdateHandler: () => {},
      getEnabledCategories: () => '',
      CategorySet: class CategorySet {
        enable() {}
        disable() {}
      },
    }),
    mksnapshot: () => ({
      setSerializeCallback: () => {},
      setDeserializeCallback: () => {},
      setDeserializeMainFunction: () => {},
      compileSerializeMain: () => {},
      isBuildingSnapshotBuffer: new Uint8Array(1),
      anonymousMainPath: '__node_anonymous_main',
      runEmbedderPreload: undefined,
    }),
    report: () => ({
      writeReport: () => '',
      getReport: () => '{}',
      getCompact: () => false,
      setCompact: () => {},
      getDirectory: () => '',
      setDirectory: () => {},
      getFilename: () => '',
      setFilename: () => {},
      getSignal: () => 'SIGUSR2',
      setSignal: () => {},
      getExcludeNetwork: () => false,
      setExcludeNetwork: () => {},
      getExcludeEnv: () => false,
      setExcludeEnv: () => {},
      shouldReportOnFatalError: () => false,
      setReportOnFatalError: () => {},
      shouldReportOnSignal: () => false,
      setReportOnSignal: () => {},
      shouldReportOnUncaughtException: () => false,
      setReportOnUncaughtException: () => {},
    }),
    heap_utils: () => ({
      createHeapSnapshotStream: () => {
        throw new Error('Heap snapshots are not available in webcore')
      },
      triggerHeapSnapshot: () => {
        throw new Error('Heap snapshots are not available in webcore')
      },
    }),
    // v8.serialize()/deserialize() need V8's wire format; the classes exist so v8 can load.
    serdes: () => ({
      Serializer: class Serializer {
        constructor() {
          throw new Error('v8.Serializer is not supported in webcore')
        }
      },
      Deserializer: class Deserializer {
        constructor() {
          throw new Error('v8.Deserializer is not supported in webcore')
        }
      },
    }),
    permission: () => ({ has: () => true, drop: () => {} }),
    wasm_web_api: () => ({ setImplementation: () => {} }),
    sea: () => ({ isSea: () => false, isExperimentalSeaWarningNeeded: () => false, getAsset: () => undefined, getAssetKeys: () => [] }),
    // AsyncContextFrame needs V8's continuation-preserved embedder data, which browsers don't
    // expose: context survives synchronous code but not across await (known M1 limitation).
    async_context_frame: () => {
      let data: unknown
      return {
        getContinuationPreservedEmbedderData: () => data,
        setContinuationPreservedEmbedderData: (value: unknown) => {
          data = value
        },
      }
    },
    // Our own binding: the host's web platform classes, for overrides (ADR-0012).
    webcore: (realm: Realm) => ({ hostGlobals: realm.hostGlobals }),
    url_pattern: (realm: Realm) => ({ URLPattern: realm.hostGlobals.URLPattern }),
    diagnostics_channel: () => ({ linkNativeChannel: () => {}, subscribers: new Uint32Array(0) }),
    profiler: () => ({
      setCoverageDirectory: () => {},
      setSourceMapCacheGetter: () => {},
      takeCoverage: () => {},
      startCoverage: () => {},
      endCoverage: () => {},
    }),
    // V8 heap introspection isn't exposed by browsers: statistics read as zero.
    v8: () => ({
      kTotalHeapSizeIndex: 0,
      kTotalHeapSizeExecutableIndex: 1,
      kTotalPhysicalSizeIndex: 2,
      kTotalAvailableSize: 3,
      kUsedHeapSizeIndex: 4,
      kHeapSizeLimitIndex: 5,
      kMallocedMemoryIndex: 6,
      kPeakMallocedMemoryIndex: 7,
      kDoesZapGarbageIndex: 8,
      kNumberOfNativeContextsIndex: 9,
      kNumberOfDetachedContextsIndex: 10,
      kTotalGlobalHandlesSizeIndex: 11,
      kUsedGlobalHandlesSizeIndex: 12,
      kExternalMemoryIndex: 13,
      kSpaceSizeIndex: 0,
      kSpaceUsedSizeIndex: 1,
      kSpaceAvailableSizeIndex: 2,
      kPhysicalSpaceSizeIndex: 3,
      kCodeAndMetadataSizeIndex: 0,
      kBytecodeAndMetadataSizeIndex: 1,
      kExternalScriptSourceSizeIndex: 2,
      kCPUProfilerMetaDataSizeIndex: 3,
      detailLevel: { BRIEF: 0, DETAILED: 1 },
      getCppHeapStatistics: () => ({}),
      cachedDataVersionTag: () => 0,
      setFlagsFromString: () => {},
      setHeapSnapshotNearHeapLimit: () => {},
      isStringOneByteRepresentation: (value: string) => /^[\x00-\xff]*$/.test(value),
      heapStatisticsBuffer: new Float64Array(14),
      heapCodeStatisticsBuffer: new Float64Array(4),
      heapSpaceStatisticsBuffer: new Float64Array(5),
      updateHeapStatisticsBuffer: () => {},
      updateHeapCodeStatisticsBuffer: () => {},
      updateHeapSpaceStatisticsBuffer: () => {},
      kHeapSpaces: [],
      GCProfiler: class GCProfiler {
        start() {}
        stop() {}
      },
    }),
  }
}
