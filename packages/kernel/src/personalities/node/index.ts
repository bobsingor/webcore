// Node.js personality (M1, ADR-0005): Node v24.21.0's own lib/ running over bindings written
// against the kernel. JavaScript runs on the host engine's JIT.
import type { BootMessage } from '../../abi/protocol.ts'
import type { Platform } from '../../process/main.ts'
import type { SyscallClient } from '../../process/syscalls.ts'
import { parseCommandLine } from './cli.ts'
import { NodeLib } from './lib.ts'
import { endThread } from './bindings/worker.ts'
import { Realm } from './realm.ts'
import { host } from './host.ts'

const kBootstrapFailure = 10
const kInvalidCommandLineArgument = 9

export function runNodejs(boot: BootMessage, sys: SyscallClient, platform: Platform): void {
  const encoder = new host.TextEncoder()
  const stderr = (text: string) => sys.call('write', 2, encoder.encode(text))
  const asset = boot.assets['node-lib']
  if (!asset) throw new Error('the Node standard library (node-lib asset) is not installed')

  const lib = new NodeLib(asset)
  // A worker_threads thread has no script on its command line: just argv0 and its execArgv.
  const threadOptions = boot.thread?.options as { argv0?: string; execArgv?: string[] } | undefined
  const argv = threadOptions ? [threadOptions.argv0 ?? boot.argv[0], ...(threadOptions.execArgv ?? [])] : boot.argv
  const commandLine = parseCommandLine(lib, argv, boot.execPath, boot.env)
  if (commandLine.error) {
    stderr(`${boot.argv[0]}: ${commandLine.error}\n`)
    sys.exit(kInvalidCommandLineArgument)
  }
  if (commandLine.version) {
    sys.call('write', 1, encoder.encode(`${lib.version}\n`))
    sys.exit(0)
  }

  const realm = new Realm({ boot, sys, platform, lib, commandLine })
  realm.loop.onExit = (code) => {
    if (boot.thread) endThread(realm, code)
    if (boot.env.WEBCORE_TRACE_BINDINGS) stderr(realm.trace.report())
  }
  platform.onUncaughtError((error) => realm.loop.uncaught(error, false))

  try {
    realm.bootstrap()
  } catch (error) {
    stderr(`node: bootstrap failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    if (boot.env.WEBCORE_TRACE_BINDINGS) stderr(realm.trace.report())
    sys.exit(kBootstrapFailure)
  }
  realm.runMain()
}
