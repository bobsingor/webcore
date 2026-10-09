// Process Worker entry for Node (worker_threads).
import { parentPort } from 'node:worker_threads'
import type { BootMessage } from '../abi/protocol.ts'
import { startProcess } from './main.ts'

const nodeProcess = process

parentPort!.once('message', (boot: BootMessage) =>
  startProcess(boot, {
    onUncaughtError(handler) {
      nodeProcess.on('uncaughtException', handler)
      nodeProcess.on('unhandledRejection', handler)
    },
  }),
)
