// File watching, like inotify: watch() returns an fd, and reading it blocks until changes arrive.
// Changes come from the kernel's own fs.change events (ADR-0010). A watch on a directory reports
// its entries (or, recursively, everything below it); a watch on a file reports the file.
import { O_RDONLY, S_IFIFO } from '../abi/constants.ts'
import type { FsOp } from './events.ts'
import { OpenFile, pseudoStat } from './files.ts'

export interface WatchEvent {
  /** fs.watch's vocabulary: 'rename' for entries appearing or disappearing, else 'change'. */
  event: 'rename' | 'change'
  /** Relative to the watched directory, or the watched file's own name. */
  path: string
}

const encoder = new TextEncoder()

export class Watcher extends OpenFile {
  readonly type = 'fifo'
  readonly path: string
  readonly recursive: boolean
  readonly isDirectory: boolean
  private readonly registry: Set<Watcher>
  private queue: WatchEvent[] = []
  private waiters: (() => void)[] = []
  private open = true

  constructor(registry: Set<Watcher>, path: string, isDirectory: boolean, recursive: boolean) {
    super(O_RDONLY)
    this.registry = registry
    this.path = path
    this.isDirectory = isDirectory
    this.recursive = recursive
    registry.add(this)
  }

  /** Queues the change if it concerns this watch. */
  notify(op: FsOp, path: string): void {
    const event = op === 'write' ? 'change' : 'rename'
    let relative: string | undefined
    if (path === this.path) relative = this.path.slice(this.path.lastIndexOf('/') + 1)
    else if (this.isDirectory && path.startsWith(this.path === '/' ? '/' : `${this.path}/`)) {
      const rest = path.slice(this.path === '/' ? 1 : this.path.length + 1)
      // Without `recursive`, only the directory's own entries are reported, as with inotify.
      if (this.recursive || !rest.includes('/')) relative = rest
    }
    if (relative === undefined) return
    const last = this.queue[this.queue.length - 1]
    if (last && last.event === event && last.path === relative) return
    this.queue.push({ event, path: relative })
    for (const wake of this.waiters.splice(0)) wake()
  }

  /** Newline-separated JSON events; waits for at least one. Returns EOF once closed. */
  override async read(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    while (!this.queue.length && this.open) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('aborted'))
        const onAbort = () => resolve()
        signal?.addEventListener('abort', onAbort, { once: true })
        this.waiters.push(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        })
      })
      if (signal?.aborted) return new Uint8Array(0)
    }
    let text = ''
    while (this.queue.length) {
      const line = `${JSON.stringify(this.queue[0])}\n`
      if (text && text.length + line.length > max) break
      text += line
      this.queue.shift()
    }
    return encoder.encode(text)
  }

  stat() {
    return pseudoStat('fifo', S_IFIFO | 0o400, 0)
  }

  protected override closed(): void {
    this.open = false
    this.registry.delete(this)
    for (const wake of this.waiters.splice(0)) wake()
  }
}
