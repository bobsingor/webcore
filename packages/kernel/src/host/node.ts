// Headless host (ADR-0011): each process runs in a worker_threads Worker.
import { Worker } from 'node:worker_threads'
import type { ProcessHost } from '../kernel/kernel.ts'
import type { WorkerLike } from '../kernel/process.ts'
import { workerPool } from './pool.ts'

const workerUrl = new URL('../process/worker-node.ts', import.meta.url)

// The worker entry is TypeScript. Node ≥ 22.18 strips types by default; older 22.x needs the flag.
const features = process.features as { typescript?: string | false }
const execArgv = features.typescript
  ? undefined
  : [...process.execArgv, '--experimental-strip-types', '--disable-warning=ExperimentalWarning']

export interface NodeProcessHostOptions {
  /** Workers kept loaded and waiting for a process to boot (default 0: tests create many kernels). */
  warmWorkers?: number
}

export function nodeProcessHost(options: NodeProcessHostOptions = {}): ProcessHost {
  const take = workerPool(options.warmWorkers ?? 0, (onError) => {
    const worker = new Worker(workerUrl, { execArgv })
    worker.on('error', onError)
    // A waiting Worker must not keep the host process alive.
    worker.unref()
    return worker
  })
  return {
    createWorker(onError): WorkerLike {
      const { worker, claim } = take()
      claim(onError)
      worker.ref()
      return {
        postMessage: (message, transfer) => worker.postMessage(message, transfer as never),
        terminate: () => void worker.terminate(),
      }
    },
  }
}
