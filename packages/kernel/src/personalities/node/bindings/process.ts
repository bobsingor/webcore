// Process-level bindings: process_methods, credentials, async_wrap, task_queue, timers, uv, os,
// constants, signal_wrap.
import { CONSTANTS } from '../data/constants.ts'
import { UV_ERRORS } from '../data/uv-errors.ts'
import type { Realm } from '../realm.ts'
import { uvCode, uvException, uvMessage, uvName } from '../uv.ts'
import { host } from '../host.ts'

// The provider list of AsyncWrap (src/async_wrap.h), in order.
const PROVIDERS = [
  'NONE', 'DIRHANDLE', 'DNSCHANNEL', 'ELDHISTOGRAM', 'FILEHANDLE', 'FILEHANDLECLOSEREQ', 'FIXEDSIZEBLOBCOPY',
  'FSEVENTWRAP', 'FSREQCALLBACK', 'FSREQPROMISE', 'GETADDRINFOREQWRAP', 'GETNAMEINFOREQWRAP', 'HEAPSNAPSHOT',
  'HTTP2SESSION', 'HTTP2STREAM', 'HTTP2PING', 'HTTP2SETTINGS', 'HTTPINCOMINGMESSAGE', 'HTTPCLIENTREQUEST',
  'JSSTREAM', 'JSUDPWRAP', 'MESSAGEPORT', 'PIPECONNECTWRAP', 'PIPESERVERWRAP', 'PIPEWRAP', 'PROCESSWRAP',
  'PROMISE', 'QUERYWRAP', 'SHUTDOWNWRAP', 'SIGNALWRAP', 'STATWATCHER', 'STREAMPIPE', 'TCPCONNECTWRAP',
  'TCPSERVERWRAP', 'TCPWRAP', 'TTYWRAP', 'UDPSENDWRAP', 'UDPWRAP', 'SIGINTWATCHDOG', 'WORKER',
  'WORKERHEAPSNAPSHOT', 'WRITEWRAP', 'ZLIB',
]

export function processBindings() {
  return {
    process_methods: (realm: Realm) => {
      const encoder = new host.TextEncoder()
      const hrtimeBuffer = new Uint32Array(3)
      const hrtimeBigInt = new BigUint64Array(hrtimeBuffer.buffer, 0, 1)
      const nowNs = () => BigInt(Math.round((host.performance.timeOrigin + host.performance.now()) * 1e6))
      const started = host.performance.now()
      let umask = 0o022
      let title = 'node'
      let debugPort = 9229
      const memory = () => (performance as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory
      return {
        hrtimeBuffer,
        hrtime: () => {
          const ns = nowNs()
          const seconds = ns / 1_000_000_000n
          hrtimeBuffer[0] = Number(seconds >> 32n)
          hrtimeBuffer[1] = Number(seconds & 0xffffffffn)
          hrtimeBuffer[2] = Number(ns % 1_000_000_000n)
        },
        hrtimeBigInt: () => {
          hrtimeBigInt[0] = nowNs()
        },
        cwd: () => realm.sys.call('getcwd'),
        chdir: (directory: string) => {
          try {
            realm.sys.call('chdir', directory)
          } catch (error) {
            throw uvException(error, 'chdir', directory)
          }
        },
        umask: (mask?: number) => {
          const previous = umask
          if (mask !== undefined) umask = mask & 0o777
          return previous
        },
        uptime: () => (host.performance.now() - started) / 1000,
        reallyExit: (code: number) => realm.loop.reallyExit(code | 0),
        abort: () => realm.loop.reallyExit(134),
        causeSegfault: () => realm.loop.reallyExit(139),
        _kill: (pid: number, signal: number) => {
          try {
            realm.sys.call('kill', pid, signal)
            return 0
          } catch (error) {
            return uvCode(error)
          }
        },
        _rawDebug: (message: string) => realm.sys.call('write', 2, encoder.encode(`${message}\n`)),
        _debugProcess: () => {},
        _debugEnd: () => {},
        _startProfilerIdleNotifier: () => {},
        _stopProfilerIdleNotifier: () => {},
        cpuUsage: (values: Float64Array) => {
          values[0] = (host.performance.now() - started) * 1000
          values[1] = 0
        },
        threadCpuUsage: (values: Float64Array) => {
          values[0] = (host.performance.now() - started) * 1000
          values[1] = 0
        },
        memoryUsage: (values: Float64Array) => {
          const info = memory()
          values[0] = info?.totalJSHeapSize ?? 0
          values[1] = info?.totalJSHeapSize ?? 0
          values[2] = info?.usedJSHeapSize ?? 0
          values[3] = 0
          values[4] = 0
        },
        rss: () => memory()?.totalJSHeapSize ?? 0,
        resourceUsage: (values: Float64Array) => values.fill(0),
        constrainedMemory: () => 0,
        availableMemory: () => 2 ** 31,
        dlopen: () => {
          throw new Error('Native addons (.node files) cannot be loaded in webcore; see ADR-0006')
        },
        _getActiveRequests: () => [],
        _getActiveHandles: () => [],
        getActiveResourcesInfo: () => [],
        setEmitWarningSync: () => {},
        resetStdioForTesting: () => {},
        execve: () => {
          throw new Error('process.execve is not supported')
        },
        loadEnvFile: (path = '.env') => {
          const parse = (realm.getInternalBinding('util') as { parseEnv(content: string): Record<string, string> }).parseEnv
          const fs = realm.requireBuiltin('fs') as { readFileSync(path: string, encoding: string): string }
          const env = realm.process.env as Record<string, string>
          for (const [key, value] of Object.entries(parse(fs.readFileSync(path, 'utf8')))) if (!(key in env)) env[key] = value
        },
        // PatchProcessObject (src/node_process_object.cc).
        patchProcessObject: (process: Record<string, unknown>) => {
          Object.defineProperty(process, 'title', {
            get: () => title,
            set: (value) => (title = String(value)),
            enumerable: true,
            configurable: true,
          })
          process.argv = [...realm.commandLine.argv]
          process.execArgv = [...realm.commandLine.execArgv]
          Object.defineProperty(process, 'pid', { value: realm.boot.pid, writable: false, enumerable: true, configurable: true })
          Object.defineProperty(process, 'ppid', { get: () => realm.boot.ppid, enumerable: true, configurable: true })
          process.execPath = realm.boot.execPath
          Object.defineProperty(process, 'debugPort', {
            get: () => debugPort,
            set: (value) => (debugPort = Number(value)),
            enumerable: true,
            configurable: true,
          })
        },
      }
    },

    credentials: (realm: Realm) => ({
      implementsPosixCredentials: true,
      safeGetenv: (key: string) => realm.boot.env[key],
      getTempDir: () => realm.boot.env.TMPDIR ?? '/tmp',
      getuid: () => 1000,
      geteuid: () => 1000,
      getgid: () => 1000,
      getegid: () => 1000,
      getgroups: () => [1000],
      setuid: () => 0,
      seteuid: () => 0,
      setgid: () => 0,
      setegid: () => 0,
      setgroups: () => 0,
      initgroups: () => 0,
    }),

    async_wrap: () => {
      const asyncIdFields = new Float64Array(4)
      // kExecutionAsyncId 1 is the main script; kDefaultTriggerAsyncId -1 means "unset".
      asyncIdFields[0] = 1
      asyncIdFields[2] = 1
      asyncIdFields[3] = -1
      return {
        async_hook_fields: new Uint32Array(9),
        async_id_fields: asyncIdFields,
        // Large enough that the C++ overflow path below is never needed in practice.
        async_ids_stack: new Float64Array(2 * 4096),
        execution_async_resources: [],
        constants: {
          kInit: 0,
          kBefore: 1,
          kAfter: 2,
          kDestroy: 3,
          kPromiseResolve: 4,
          kTotals: 5,
          kCheck: 6,
          kStackLength: 7,
          kUsesExecutionAsyncResource: 8,
          kExecutionAsyncId: 0,
          kTriggerAsyncId: 1,
          kAsyncIdCounter: 2,
          kDefaultTriggerAsyncId: 3,
        },
        Providers: Object.fromEntries(PROVIDERS.map((name, index) => [name, index])),
        setupHooks: () => {},
        setCallbackTrampoline: () => {},
        pushAsyncContext: () => {
          throw new Error('async context stack overflow')
        },
        popAsyncContext: () => false,
        executionAsyncResource: () => undefined,
        clearAsyncIdStack: () => {},
        queueDestroyAsyncId: () => {},
        registerDestroyHook: () => {},
        // V8 promise hooks are not exposed by browsers.
        setPromiseHooks: () => {},
        getPromiseHooks: () => [undefined, undefined, undefined, undefined],
      }
    },

    task_queue: (realm: Realm) => ({
      tickInfo: realm.loop.tickInfo,
      // Browsers run microtasks implicitly; there is no queue to run explicitly (see loop.ts).
      runMicrotasks: () => {},
      enqueueMicrotask: (callback: () => void) => host.queueMicrotask(callback),
      setTickCallback: (callback: () => void) => {
        realm.loop.tickCallback = callback
      },
      promiseRejectEvents: {
        kPromiseRejectWithNoHandler: 0,
        kPromiseHandlerAddedAfterReject: 1,
        kPromiseResolveAfterResolved: 2,
        kPromiseRejectAfterResolved: 3,
      },
      setPromiseRejectCallback: (callback: (type: number, promise: Promise<unknown>, reason?: unknown) => void) => {
        realm.platform.onUnhandledRejection((reason, promise) => realm.loop.callback(() => callback(0, promise, reason)))
        realm.platform.onRejectionHandled((promise) => realm.loop.callback(() => callback(1, promise)))
      },
    }),

    timers: (realm: Realm) => ({
      getLibuvNow: () => realm.loop.now(),
      setupTimers: (processImmediate: () => void, processTimers: (now: number) => number) => {
        realm.loop.processImmediate = processImmediate
        realm.loop.processTimers = processTimers
      },
      scheduleTimer: (ms: number) => realm.loop.scheduleTimer(ms),
      toggleTimerRef: (refed: boolean) => realm.loop.toggleTimerRef(refed),
      // Liveness reads immediateInfo[kRefCount] directly.
      toggleImmediateRef: () => {},
      immediateInfo: realm.loop.immediateInfo,
      timeoutInfo: new Int32Array(1),
    }),

    uv: () => {
      const binding: Record<string, unknown> = {
        errname: (code: number) => uvName(code),
        getErrorMessage: (code: number) => uvMessage(code),
        getErrorMap: () => new Map(UV_ERRORS.map(([code, name, message]) => [code, [name, message]])),
      }
      for (const [code, name] of UV_ERRORS) binding[`UV_${name}`] = code
      return binding
    },

    os: (realm: Realm) => {
      const cores = Math.max(1, host.navigator?.hardwareConcurrency ?? 1)
      const env = realm.boot.env
      return {
        getHostname: () => 'webcore',
        getLoadAvg: (values: Float64Array) => values.fill(0),
        getUptime: () => Math.floor(host.performance.now() / 1000),
        getTotalMem: () => 2 ** 31,
        getFreeMem: () => 2 ** 30,
        // Flat [model, speed, user, nice, sys, idle, irq] per CPU.
        getCPUs: () => Array.from({ length: cores }, () => ['webcore', 0, 0, 0, 0, 0, 0]).flat(),
        getInterfaceAddresses: () => [],
        getHomeDirectory: () => env.HOME ?? '/home/user',
        getUserInfo: () => ({
          uid: 1000,
          gid: 1000,
          username: env.USER ?? 'user',
          homedir: env.HOME ?? '/home/user',
          shell: env.SHELL ?? null,
        }),
        setPriority: () => 0,
        getPriority: () => 0,
        getOSInformation: () => ['Linux', '#1 SMP webcore', '6.0.0-webcore', 'wasm32'],
        isBigEndian: false,
        getAvailableParallelism: () => cores,
      }
    },

    constants: () => CONSTANTS,

    signal_wrap: () => ({
      // Signals cannot be delivered to a Worker yet; handlers are registered but never fire.
      Signal: class Signal {
        start() {
          return 0
        }
        close(callback?: () => void) {
          callback?.()
        }
        ref() {}
        unref() {}
        hasRef() {
          return false
        }
        getAsyncId() {
          return -1
        }
      },
    }),
  }
}
