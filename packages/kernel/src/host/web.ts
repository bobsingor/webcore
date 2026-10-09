import type { ProcessHost } from '../kernel/kernel.ts'
import type { WorkerLike } from '../kernel/process.ts'

/** Starts each process in a module Web Worker. The page must be cross-origin isolated. */
export function webProcessHost(): ProcessHost {
  if (!globalThis.crossOriginIsolated) {
    throw new Error(
      'webcore needs cross-origin isolation for SharedArrayBuffer. Serve the page with ' +
        '"Cross-Origin-Opener-Policy: same-origin" and "Cross-Origin-Embedder-Policy: require-corp".',
    )
  }
  return {
    createWorker(onError): WorkerLike {
      const worker = new Worker(new URL('../process/worker.ts', import.meta.url), {
        type: 'module',
        name: 'webcore-process',
      })
      worker.addEventListener('error', (event) => {
        event.preventDefault()
        onError(event.error ?? new Error(event.message || 'process worker failed to start'))
      })
      return worker
    },
  }
}
