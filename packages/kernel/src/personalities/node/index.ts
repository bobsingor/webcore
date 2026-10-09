// Node.js personality (M1, ADR-0005): Node v24.21.0's own lib/ running over bindings written
// against the kernel. JavaScript runs on the host engine's JIT.
import type { BootMessage } from '../../abi/protocol.ts'
import type { Platform } from '../../process/main.ts'
import type { SyscallClient } from '../../process/syscalls.ts'
import { parseCommandLine } from './cli.ts'
import { NodeLib } from './lib.ts'
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
  const commandLine = parseCommandLine(lib, boot.argv, boot.execPath, boot.env)
  if (commandLine.error) {
    stderr(`${boot.argv[0]}: ${commandLine.error}\n`)
    sys.exit(kInvalidCommandLineArgument)
  }
  if (commandLine.version) {
    sys.call('write', 1, encoder.encode(`${lib.version}\n`))
    sys.exit(0)
  }

  const realm = new Realm({ boot, sys, platform, lib, commandLine })
  if (boot.env.WEBCORE_TRACE_BINDINGS) realm.loop.onExit = () => stderr(realm.trace.report())
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
