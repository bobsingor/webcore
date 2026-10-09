// Node.js personality, M0 edition: a deliberately small hand-written shim that proves the kernel
// transport for JavaScript processes. In M1 it is replaced by Node's own lib/ running over
// kernel-implemented internalBindings (ADR-0005). JavaScript runs on the host engine's JIT.
import type { BootMessage } from '../../abi/protocol.ts'
import type { SyscallClient } from '../../process/syscalls.ts'
import type { Platform } from '../../process/main.ts'
import { Buffer } from './buffer.ts'
import { createAssert, createConsole, createOs, createUrl, createUtil } from './builtins.ts'
import { createChildProcess } from './child_process.ts'
import { createEventsModule } from './events.ts'
import { createFs } from './fs.ts'
import { inspect } from './inspect.ts'
import { EventLoop } from './loop.ts'
import { ModuleSystem } from './modules.ts'
import { createPath } from './path.ts'
import { createProcess, NODE_VERSION, type NodeProcess } from './process.ts'

export function runNode(boot: BootMessage, sys: SyscallClient, platform: Platform): void {
  let exiting = false
  const exit = (code: number): never => {
    if (!exiting) {
      exiting = true
      proc.exitCode = code
      try {
        proc.emit('exit', code)
      } catch {
        // Errors in 'exit' listeners can't change the outcome.
      }
    }
    return sys.exit(code)
  }

  const loop = new EventLoop(() => {
    if (exiting) return
    proc.emit('beforeExit', proc.exitCode ?? 0)
    if (loop.isIdle) exit(proc.exitCode ?? 0)
  })
  const proc: NodeProcess = createProcess(boot, sys, loop, exit)
  const path = createPath(() => proc.cwd())
  const fs = createFs(sys, loop, path)
  const timers = loop.timerGlobals()
  const console = createConsole(proc.stdout, proc.stderr)
  const events = createEventsModule()

  const builtins: Record<string, () => unknown> = {
    assert: createAssert,
    buffer: () => ({ Buffer, kMaxLength: 2 ** 32, constants: { MAX_LENGTH: 2 ** 32 } }),
    child_process: () => createChildProcess(sys),
    console: () => console,
    events: () => events,
    fs: () => fs,
    'fs/promises': () => fs.promises,
    module: () => ({
      builtinModules: modules.builtinModules,
      createRequire: (filename: string) => modules.createRequire(undefined, path.dirname(filename)),
    }),
    os: () => createOs(proc),
    path: () => path,
    'path/posix': () => path,
    process: () => proc,
    timers: () => timers,
    'timers/promises': () => ({
      setTimeout: (ms?: number, value?: unknown) => new Promise((resolve) => timers.setTimeout(() => resolve(value), ms)),
      setImmediate: (value?: unknown) => new Promise((resolve) => timers.setImmediate(() => resolve(value))),
    }),
    url: () => createUrl(path),
    util: createUtil,
  }
  const modules = new ModuleSystem(fs, path, builtins)

  const globals: Record<string, unknown> = { global: globalThis, process: proc, Buffer, console, ...timers }
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false })
  }

  const reportUncaught = (error: unknown) => {
    if (exiting) return
    if (proc.listenerCount('uncaughtException') > 0) {
      proc.emit('uncaughtException', error)
      return
    }
    const text = error instanceof Error ? (error.stack ?? String(error)) : `Uncaught ${inspect(error)}`
    try {
      proc.stderr.write(`${text}\n\nNode.js ${NODE_VERSION}\n`)
    } finally {
      exit(1)
    }
  }
  platform.onUncaughtError(reportUncaught)

  try {
    runEntry()
  } catch (error) {
    reportUncaught(error)
  }
  loop.check()

  function runEntry(): void {
    const args = boot.argv.slice(1)
    const cwd = proc.cwd()
    const [first] = args
    switch (first) {
      case '-v':
      case '--version':
        proc.stdout.write(`${NODE_VERSION}\n`)
        exit(0)
        return
      case '-e':
      case '--eval':
      case '-p':
      case '--print': {
        if (args[1] === undefined) {
          proc.stderr.write(`${boot.argv[0]}: ${first} requires an argument\n`)
          exit(9)
        }
        proc.argv = [boot.execPath, ...args.slice(2)]
        const result = modules.runSource('[eval]', args[1], cwd, first === '-p' || first === '--print')
        if (first === '-p' || first === '--print') console.log(result)
        return
      }
      case undefined:
      case '-':
        // Like Node with a non-TTY stdin: the program is read from stdin.
        proc.argv = [boot.execPath, ...args.slice(1)]
        modules.runSource('[stdin]', String(fs.readFileSync(0, 'utf8')), cwd)
        return
    }
    if (first.startsWith('-')) {
      proc.stderr.write(`${boot.argv[0]}: bad option: ${first}\n`)
      exit(9)
    }
    proc.argv = [boot.execPath, path.resolve(cwd, first), ...args.slice(1)]
    modules.runFile(first, cwd)
  }
}
