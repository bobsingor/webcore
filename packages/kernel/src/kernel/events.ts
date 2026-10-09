// Structured kernel events (ADR-0010). Emitted after the action succeeds; never awaited.

export type FsOp = 'create' | 'write' | 'unlink' | 'mkdir' | 'rmdir' | 'rename'

export type KernelEventBody =
  | { type: 'process.spawn'; pid: number; ppid: number; argv: string[]; cwd: string }
  /** The process now runs another program (execve). */
  | { type: 'process.exec'; pid: number; argv: string[] }
  | { type: 'process.exit'; pid: number; code: number }
  | { type: 'fs.change'; op: FsOp; path: string; to?: string }
  | { type: 'net.listen'; pid: number; port: number; address: string }
  | { type: 'net.close'; pid: number; port: number }
  /** A directory was hashed into the object store (ADR-0007). */
  | { type: 'fs.snapshot'; path: string; hash: string }
  /** A directory was replaced by a snapshot; fs.change events for the differences follow. */
  | { type: 'fs.restore'; path: string; hash: string }
  /** A workspace's state reached persistent storage (host/workspace.ts). */
  | { type: 'workspace.save'; name: string; head: string }

export type KernelEvent = KernelEventBody & { seq: number; time: number }

export type KernelEventListener = (event: KernelEvent) => void

export class EventBus {
  private readonly listeners = new Set<KernelEventListener>()
  private seq = 0

  subscribe(listener: KernelEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(body: KernelEventBody): void {
    const event = { ...body, seq: ++this.seq, time: Date.now() } as KernelEvent
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[kernel] event listener failed', error)
      }
    }
  }
}
