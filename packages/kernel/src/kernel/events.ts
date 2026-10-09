// Structured kernel events (ADR-0010). Emitted after the action succeeds; never awaited.

export type FsOp = 'create' | 'write' | 'unlink' | 'mkdir' | 'rmdir' | 'rename'

export type KernelEventBody =
  | { type: 'process.spawn'; pid: number; ppid: number; argv: string[]; cwd: string }
  | { type: 'process.exit'; pid: number; code: number }
  | { type: 'fs.change'; op: FsOp; path: string; to?: string }

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
