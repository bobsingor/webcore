// Shared body of every process Worker. Each environment has its own tiny entry file that receives
// the boot message and supplies a Platform (ADR-0011): worker.ts (browsers) and worker-node.ts.
// Entries must not contain anything else: whatever runs in the Worker shares globals with the
// guest program.
import type { BootMessage } from '../abi/protocol.ts'
import { runNodejs } from '../personalities/node/index.ts'
import { runWasi } from '../personalities/wasi/index.ts'
import { SyscallClient } from './syscalls.ts'

/** Hooks for errors that escape the guest program, provided per environment. */
export interface Platform {
  onUncaughtError(handler: (error: unknown) => void): void
  onUnhandledRejection(handler: (reason: unknown, promise: Promise<unknown>) => void): void
  onRejectionHandled(handler: (promise: Promise<unknown>) => void): void
}

export function startProcess(boot: BootMessage, platform: Platform): void {
  const sys = new SyscallClient(boot.port, boot.page)
  try {
    if (boot.personality === 'wasi') runWasi(boot, sys)
    else runNodejs(boot, sys, platform)
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    try {
      sys.call('write', 2, new TextEncoder().encode(`${boot.argv[0]}: ${message}\n`))
    } finally {
      sys.exit(1)
    }
  }
}
