import type { ProcessHost } from '../kernel/kernel.ts'
import type { WorkerLike } from '../kernel/process.ts'
import { workerPool } from './pool.ts'

export interface WebProcessHostOptions {
  /** Workers kept loaded and waiting for a process to boot (default 2). */
  warmWorkers?: number
}

/** Starts each process in a module Web Worker. The page must be cross-origin isolated. */
export function webProcessHost(options: WebProcessHostOptions = {}): ProcessHost {
  if (!globalThis.crossOriginIsolated) {
    throw new Error(
      'webcore needs cross-origin isolation for SharedArrayBuffer. Serve the page with ' +
        '"Cross-Origin-Opener-Policy: same-origin" and "Cross-Origin-Embedder-Policy: require-corp".',
    )
  }
  const take = workerPool(options.warmWorkers ?? 2, (onError) => {
    const worker = new Worker(new URL('../process/worker.ts', import.meta.url), {
      type: 'module',
      name: 'webcore-process',
    })
    worker.addEventListener('error', (event) => {
      event.preventDefault()
      onError(event.error ?? new Error(event.message || 'process worker failed to start'))
    })
    return worker
  })
  return {
    createWorker(onError): WorkerLike {
      const { worker, claim } = take()
      claim(onError)
      return worker
    },
  }
}
