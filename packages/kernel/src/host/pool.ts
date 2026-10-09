// Warm Workers: each process (or thread) takes a Worker that has already loaded and evaluated its
// entry script, and a replacement starts in the background. Errors a waiting Worker reports before
// it's taken are replayed to its owner.

export interface PooledWorker<W> {
  worker: W
  /** Routes the Worker's errors to `onError`, including one that happened while it waited. */
  claim(onError: (error: unknown) => void): void
}

export function workerPool<W>(size: number, spawn: (onError: (error: unknown) => void) => W): () => PooledWorker<W> {
  const idle: PooledWorker<W>[] = []
  const make = (): PooledWorker<W> => {
    let early: unknown
    let handler: ((error: unknown) => void) | undefined
    const worker = spawn((error) => (handler ? handler(error) : (early ??= error)))
    return {
      worker,
      claim(onError) {
        handler = onError
        if (early !== undefined) onError(early)
      },
    }
  }
  let refilling = false
  const refill = () => {
    if (refilling) return
    refilling = true
    setTimeout(() => {
      refilling = false
      while (idle.length < size) idle.push(make())
    }, 0)
  }
  if (size > 0) refill()
  return () => {
    const taken = idle.shift() ?? make()
    if (size > 0) refill()
    return taken
  }
}
