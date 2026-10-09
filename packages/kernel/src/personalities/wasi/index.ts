// The WASI personality (ADR-0004, ADR-0020): a WASI or WASIX command as a process.
//
// The program's fds are the kernel's own. "/" is preopened as a virtual fd just past the kernel's
// (PREOPEN_FD), so no program can close or replace it, and libc's preopen scan skips every fd
// below it. A WASIX program imports a shared memory, which the process creates from the limits
// the kernel read in the module's import section.
//
// Signals: between syscalls, a process checks the doorbell in its syscall page. When it rang, the
// process takes its signals from the kernel and calls the handler libc registered (or waits there
// while stopped). A sleep wakes on the doorbell too.
import { AT_FDCWD, type Stat } from '../../abi/constants.ts'
import { Errno } from '../../abi/errno.ts'
import { bellRang, sleepUntilBell } from '../../abi/page.ts'
import type { BootMessage } from '../../abi/protocol.ts'
import { MAX_FDS } from '../../kernel/process.ts'
import { SysError, type SyscallClient } from '../../process/syscalls.ts'
import { preview1, WASI_ENOSYS, type Fds, type Imports } from './preview1.ts'
import { wasixImports } from './wasix.ts'

/** The fd of the "/" preopen: past every fd the kernel hands out. */
export const PREOPEN_FD = MAX_FDS

/** Memory beyond this many 64 KiB pages isn't reserved, whatever a module allows (1 GiB). */
const MAX_PAGES = 16384

const encoder = new TextEncoder()

/** The kernel's fds as they are, plus the virtual "/" preopen. */
function identityFds(sys: SyscallClient, dup2Renumber: boolean): Fds {
  const root = encoder.encode('/')
  const check = (fd: number) => {
    if (!Number.isInteger(fd) || fd < 0 || fd >= MAX_FDS) throw new SysError(Errno.EBADF, 'wasi')
    return fd
  }
  return {
    kernel: check,
    at: (fd, path) => (fd === PREOPEN_FD ? [AT_FDCWD, `/${path}`] : [check(fd), path]),
    add: (kernelFd) => kernelFd,
    close(fd) {
      if (fd !== PREOPEN_FD) sys.call('close', check(fd))
    },
    // WASIX's dup2 is fd_renumber, which keeps `from` open; preview1's moves it.
    renumber(from, to) {
      sys.call('dup2', check(from), check(to))
      if (!dup2Renumber && from !== to) sys.call('close', from)
    },
    prestat: (fd) => (fd === PREOPEN_FD ? root : fd > 2 && fd < PREOPEN_FD ? null : undefined),
    closeAll() {},
  }
}

export function runWasi(boot: BootMessage, sys: SyscallClient): never {
  const module = boot.module
  if (!module) throw new Error('missing Wasm module')
  const imported = WebAssembly.Module.imports(module)
  const wasix = imported.some((entry) => entry.module === 'wasix_32v1' || entry.module === 'webcore')
  const page = boot.page

  let memory: WebAssembly.Memory | undefined
  if (boot.memory) {
    const { initial, maximum, shared } = boot.memory
    memory = new WebAssembly.Memory({ initial, maximum: Math.max(initial, Math.min(maximum ?? MAX_PAGES, MAX_PAGES)), shared })
  }

  let instance: WebAssembly.Instance | undefined
  let signalCallback: string | undefined
  const undelivered: number[] = []
  let lastStat: Stat | undefined

  /** Runs libc's handler for each signal, or keeps them until libc registers one. */
  const deliver = (signals: number[]) => {
    const handler = signalCallback ? instance?.exports[signalCallback] : undefined
    if (typeof handler !== 'function') {
      undelivered.push(...signals)
      return
    }
    for (const signal of signals) (handler as (signal: number) => void)(signal)
  }
  /** After a syscall: takes the signals the doorbell announced. Returns how many there were. */
  const takeSignals = (): number => {
    if (!bellRang(page)) return 0
    const signals = sys.call('takeSignals')
    deliver(signals)
    return signals.length
  }
  // A call interrupted for a handler that restarts calls (SA_RESTART) is made again after it ran.
  if (wasix) sys.onRestart = takeSignals
  const sleep = (ms: number): boolean => {
    const deadline = performance.now() + ms
    for (;;) {
      const left = deadline - performance.now()
      if (left <= 0) return true
      sleepUntilBell(page, left)
      if (takeSignals()) return false
    }
  }

  const fds = identityFds(sys, wasix)
  const vforks: { pid: number; ppid: number }[] = []
  const exit = (code: number): never => sys.exit(code)
  const wasi = preview1({
    sys,
    args: boot.argv,
    env: Object.entries(boot.env).map(([key, value]) => `${key}=${value}`),
    fds,
    memory: () => memory!,
    exit,
    sleep,
    onStat: (stat) => (lastStat = stat),
  })
  const namespaces: Record<string, Imports> = { wasi_snapshot_preview1: wasi.imports }
  if (wasix) {
    Object.assign(
      namespaces,
      wasixImports({
        sys,
        fds,
        page,
        memory: () => memory!,
        guard: wasi.guard,
        pid: () => vforks.at(-1)?.pid ?? boot.pid,
        ppid: () => vforks.at(-1)?.ppid ?? boot.ppid,
        vforks,
        ignored: boot.ignored ?? [],
        env: boot.env,
        onSignalCallback(name) {
          signalCallback = name
          if (undelivered.length) deliver(undelivered.splice(0))
        },
        sleep,
        exit,
        lastStat: () => lastStat,
      }),
    )
    // path_open2 is WASIX's, next to preview1's path_open.
    namespaces.wasix_32v1.path_open2 = wasi.imports.path_open2
  }

  const imports: WebAssembly.Imports = {}
  for (const entry of imported) {
    const namespace = (imports[entry.module] ??= {}) as Record<string, unknown>
    if (entry.kind === 'memory' && memory) {
      namespace[entry.name] = memory
    } else if (entry.kind === 'function') {
      const fn = namespaces[entry.module]?.[entry.name]
      if (typeof fn !== 'function') namespace[entry.name] = () => WASI_ENOSYS
      else if (!wasix) namespace[entry.name] = fn
      else {
        // Signals reach a WASIX program between syscalls.
        namespace[entry.name] = (...args: never[]) => {
          const result = fn(...args)
          takeSignals()
          return result
        }
      }
    }
  }

  const report = (message: string) => sys.call('write', 2, encoder.encode(`${boot.argv[0]}: ${message}\n`))
  instance = new WebAssembly.Instance(module, imports)
  memory ??= instance.exports.memory as WebAssembly.Memory | undefined
  const start = instance.exports._start
  if (!memory || typeof start !== 'function') {
    report('not a WASI command (missing memory or _start)')
    return sys.exit(126)
  }

  try {
    ;(start as () => void)()
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      report(`wasm trap: ${error.message}`)
      return sys.exit(134)
    }
    if (error instanceof WebAssembly.Exception) {
      report('uncaught Wasm exception')
      return sys.exit(134)
    }
    throw error
  }
  return sys.exit(0)
}
