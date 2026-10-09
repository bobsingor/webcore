// worker (src/node_worker.cc): worker_threads over kernel threads (ADR-0016). A thread is another
// Worker in the same process. The parent's Worker handle and the thread talk over a host
// MessagePort, the "env port", which the thread receives in its boot message.
//
// Ordering: before 'exit', Node delivers everything the thread sent. Here the kernel reports the
// thread's end on a different channel than the env port, so the thread posts an exit sentinel as
// the last thing on the env port, and the parent joins once it has both. Messages on other
// channels (parentPort has its own) aren't ordered with the env port, so the sentinel says how
// many the thread sent on each, and the parent also waits for those. A thread that was terminated
// never sends one; the parent then waits a moment for messages already in flight.
import { host } from '../host.ts'
import type { Realm } from '../realm.ts'
import { messagingOf, type SentCount } from './messaging.ts'

const DEFAULT_LIMITS = [16, 4096, 0, 4]

export function workerBindings() {
  return {
    worker: (realm: Realm) => {
      const { sys, loop } = realm
      const thread = realm.boot.thread
      const options = (thread?.options ?? {}) as {
        name?: string
        isInternal?: boolean
        resourceLimits?: number[]
      }
      const messaging = messagingOf(realm)
      let envPort: object | undefined

      class Worker {
        messagePort: object | undefined
        threadId = 0
        threadName = ''
        invalidExecArgv?: string[]
        invalidNodeOptions?: string[]
        onexit?: (code: number, customErr: string | null, customErrReason: string | null) => void
        #hostPort?: MessagePort
        #env: Record<string, string> = {}
        #options: Record<string, unknown> = {}
        #limits: number[] = []
        #refed = true
        #running = false
        #joined = false
        #waitCode?: number
        #sentinelCode?: number
        #sentinelCounts: SentCount[] = []

        constructor(
          _url: unknown,
          env: Record<string, string> | null | undefined,
          execArgv: string[] | undefined,
          limits: Float64Array,
          _trackUnmanagedFds: boolean,
          isInternal: boolean,
          name: string,
        ) {
          const argv = execArgv ?? realm.commandLine.execArgv
          if (execArgv) {
            const invalid = argv.filter((arg) => arg.startsWith('-') && !realm.isKnownOption(arg))
            if (invalid.length) {
              this.invalidExecArgv = invalid
              return
            }
          }
          // Ids are process-wide and needed now, before the thread starts: a shared counter.
          this.threadId = Atomics.add(realm.threadIdCounter, 0, 1) + 1
          this.threadName = String(name ?? 'WorkerThread')
          const channel = new host.MessageChannel()
          this.messagePort = messaging.wrap(channel.port1, (message) => {
            if (message.t !== 'x') return
            this.#sentinelCode = Number(message.code)
            this.#sentinelCounts = (message.sent as SentCount[] | undefined) ?? []
            this.#maybeJoin()
          })
          this.#hostPort = channel.port2
          // null: a copy of the current env; undefined: SHARE_ENV (approximated by a copy).
          this.#env = { ...(env ?? (realm.process.env as Record<string, string>)) }
          this.#limits = Array.from(limits, (value, i) => (value > 0 ? value : DEFAULT_LIMITS[i]))
          this.#options = {
            name: this.threadName,
            isInternal: Boolean(isInternal),
            execArgv: argv,
            resourceLimits: this.#limits,
            argv0: realm.process.argv0,
            threadIdCounter: realm.threadIdCounter,
          }
        }

        startThread() {
          this.#running = true
          if (this.#refed) loop.ref()
          const port = this.#hostPort!
          sys
            .callAsyncTransfer('threadSpawn', [{ id: this.threadId, env: this.#env, options: this.#options }, port], [port])
            .then(() => sys.callAsync('threadWait', this.threadId))
            .then(
              (code) => {
                this.#waitCode = code
                this.#maybeJoin()
              },
              (error: Error) => this.#join(1, 'ERR_WORKER_INIT_FAILED', error.message),
            )
        }

        stopThread() {
          sys.callAsync('threadTerminate', this.threadId).catch(() => {})
        }

        ref() {
          if (this.#refed) return
          this.#refed = true
          if (this.#running) loop.ref()
        }

        unref() {
          if (!this.#refed) return
          this.#refed = false
          if (this.#running) loop.unref()
        }

        hasRef() {
          return this.#refed
        }

        getResourceLimits() {
          return Float64Array.from(this.#limits)
        }

        loopIdleTime() {
          return 0
        }

        loopStartTime() {
          return -1
        }

        getAsyncId() {
          return -1
        }

        // Profiling a thread isn't available; lib reports ERR_WORKER_NOT_RUNNING.
        takeHeapSnapshot() {
          return undefined
        }

        getHeapStatistics() {
          return undefined
        }

        cpuUsage() {
          return undefined
        }

        #maybeJoin() {
          if (this.#joined || this.#waitCode === undefined) return
          const code = this.#sentinelCode
          if (code !== undefined) return messaging.whenReceived(this.#sentinelCounts, () => this.#join(code))
          // Terminated or crashed: let messages already in flight arrive first.
          host.setTimeout(() => this.#join(this.#sentinelCode ?? this.#waitCode!), 20)
        }

        #join(code: number, customErr: string | null = null, reason: string | null = null) {
          if (this.#joined) return
          this.#joined = true
          if (this.#running && this.#refed) loop.unref()
          this.#running = false
          this.messagePort = undefined
          loop.callback(() => this.onexit?.call(this, code, customErr, reason))
        }
      }

      return {
        Worker,
        isMainThread: !thread,
        isInternalThread: Boolean(thread && options.isInternal),
        ownsProcessState: !thread,
        threadId: thread?.id ?? 0,
        threadName: thread ? String(options.name ?? 'WorkerThread') : '',
        ...(thread ? { resourceLimits: Float64Array.from(options.resourceLimits ?? DEFAULT_LIMITS) } : {}),
        kMaxYoungGenerationSizeMb: 0,
        kMaxOldGenerationSizeMb: 1,
        kCodeRangeSizeMb: 2,
        kStackSizeMb: 3,
        kTotalResourceLimitCount: 4,
        getEnvMessagePort: () => (thread ? (envPort ??= messaging.wrap(thread.port)) : undefined),
      }
    },
  }
}

/** A thread's last words: an exit sentinel after everything else on its env port, then close. */
export function endThread(realm: Realm, code: number): void {
  const thread = realm.boot.thread
  if (!thread) return
  const messaging = messagingOf(realm)
  const worker = realm.getInternalBinding('worker') as { getEnvMessagePort(): object }
  messaging.sendControl(worker.getEnvMessagePort(), { t: 'x', code, sent: messaging.sentCounts() })
  messaging.closeAll()
}
