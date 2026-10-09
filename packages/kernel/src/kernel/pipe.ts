import { kerr } from '../abi/errno.ts'

const EMPTY = new Uint8Array(0)

type Waiter = () => void

/**
 * A unidirectional byte pipe with blocking reads and bounded writes.
 *
 * Reads wait for data and return an empty array at EOF (all writers closed). Writes wait while the
 * buffer is over capacity and fail with EPIPE once the read end is closed. The capacity is soft: a
 * write is accepted whole once there is any room, so one large write never deadlocks a reader.
 */
export class Pipe {
  readonly capacity: number
  private chunks: Uint8Array[] = []
  private buffered = 0
  private readOpen = true
  private writeOpen = true
  private readers: Waiter[] = []
  private writers: Waiter[] = []

  constructor(capacity = 64 * 1024) {
    this.capacity = capacity
  }

  get size(): number {
    return this.buffered
  }

  async read(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    for (;;) {
      if (this.buffered > 0) return this.take(max)
      if (!this.writeOpen) return EMPTY
      await this.park(this.readers, signal)
    }
  }

  async write(data: Uint8Array, signal?: AbortSignal): Promise<number> {
    for (;;) {
      if (!this.readOpen) throw kerr('EPIPE')
      if (this.buffered < this.capacity) {
        if (data.length) {
          this.chunks.push(data.slice())
          this.buffered += data.length
          this.wake(this.readers)
        }
        return data.length
      }
      await this.park(this.writers, signal)
    }
  }

  closeRead(): void {
    this.readOpen = false
    this.chunks = []
    this.buffered = 0
    this.wake(this.writers)
  }

  closeWrite(): void {
    this.writeOpen = false
    this.wake(this.readers)
  }

  private take(max: number): Uint8Array {
    const out = new Uint8Array(Math.min(max, this.buffered))
    let offset = 0
    while (offset < out.length) {
      const chunk = this.chunks[0]
      const n = Math.min(chunk.length, out.length - offset)
      out.set(chunk.subarray(0, n), offset)
      offset += n
      if (n === chunk.length) this.chunks.shift()
      else this.chunks[0] = chunk.subarray(n)
    }
    this.buffered -= out.length
    this.wake(this.writers)
    return out
  }

  private park(queue: Waiter[], signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(kerr('EINTR'))
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = queue.indexOf(waiter)
        if (index >= 0) queue.splice(index, 1)
        reject(kerr('EINTR'))
      }
      const waiter = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      queue.push(waiter)
    })
  }

  private wake(queue: Waiter[]): void {
    for (const waiter of queue.splice(0)) waiter()
  }
}
