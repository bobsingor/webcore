// Workspaces (M2b): a kernel's /home kept between page loads. Objects (ADR-0007) are written to
// storage as packs, one per save, holding what the store gained since the previous save. A
// workspace record names its current tree (head) and the snapshots kept on request. Every
// workspace in one storage shares the objects, so forks and copies cost nothing until they change.
//
// Storage is a small key/value interface: OPFS in the browser (@webcore/runtime), memory in tests.
import { kerr } from '../abi/errno.ts'
import type { Kernel } from '../kernel/kernel.ts'
import { reachable } from '../kernel/snapshot.ts'
import { fromHex, toHex, type MemoryStore } from '../kernel/store.ts'

export interface WorkspaceStorage {
  /** Names under `prefix` ("packs/", "workspaces/"). */
  list(prefix: string): Promise<string[]>
  read(name: string): Promise<Uint8Array | undefined>
  write(name: string, data: Uint8Array): Promise<void>
  remove(name: string): Promise<void>
}

export interface WorkspaceOptions {
  /** The workspace's name; one record per name. */
  name: string
  /** The directory it covers. Default: /home. */
  path?: string
  /** Start from this snapshot instead of the workspace's own head (a fork). */
  from?: string
  /** Save after changes stop for this long (ms). Default: 1000. */
  delay?: number
  /** …but at least this often while changes continue (ms). Default: 10000. */
  maxDelay?: number
  /** Whether this workspace may write. False: it loads, but never saves (another tab holds it). */
  writable?: boolean
}

interface WorkspaceRecord {
  head?: string
  /** Snapshots taken on request: kept when storage is compacted. */
  kept: string[]
  saved?: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const HASH_BYTES = 32

/** Pack format: records of [32-byte hash][u32 little-endian length][bytes]. */
export function encodePack(objects: [string, Uint8Array][]): Uint8Array {
  const total = objects.reduce((sum, [, bytes]) => sum + HASH_BYTES + 4 + bytes.length, 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let offset = 0
  for (const [hash, bytes] of objects) {
    out.set(fromHex(hash), offset)
    view.setUint32(offset + HASH_BYTES, bytes.length, true)
    out.set(bytes, offset + HASH_BYTES + 4)
    offset += HASH_BYTES + 4 + bytes.length
  }
  return out
}

export function* decodePack(pack: Uint8Array): Generator<[string, Uint8Array]> {
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength)
  let offset = 0
  while (offset + HASH_BYTES + 4 <= pack.length) {
    const hash = toHex(pack.subarray(offset, offset + HASH_BYTES))
    const length = view.getUint32(offset + HASH_BYTES, true)
    const start = offset + HASH_BYTES + 4
    if (start + length > pack.length) throw kerr('EIO', 'truncated pack')
    yield [hash, pack.subarray(start, start + length)]
    offset = start + length
  }
}

export class Workspace {
  readonly name: string
  readonly path: string
  readonly writable: boolean
  private readonly kernel: Kernel
  private readonly storage: WorkspaceStorage
  private readonly delay: number
  private readonly maxDelay: number
  private record: WorkspaceRecord = { kept: [] }
  private timer?: ReturnType<typeof setTimeout>
  private firstChange?: number
  private saving: Promise<string | undefined> = Promise.resolve(undefined)
  private unsubscribe?: () => void
  private packCounter = 0

  private constructor(kernel: Kernel, storage: WorkspaceStorage, options: WorkspaceOptions) {
    this.kernel = kernel
    this.storage = storage
    this.name = options.name
    this.path = options.path ?? '/home'
    this.delay = options.delay ?? 1000
    this.maxDelay = options.maxDelay ?? 10_000
    this.writable = options.writable ?? true
  }

  /**
   * Loads every stored object into the kernel's store, restores the workspace's head (or `from`)
   * into its directory, and saves from then on whenever it changes.
   */
  static async open(kernel: Kernel, storage: WorkspaceStorage, options: WorkspaceOptions): Promise<Workspace> {
    const workspace = new Workspace(kernel, storage, options)
    await workspace.load()
    const start = options.from ?? workspace.record.head
    if (start) await kernel.restore(start, workspace.path)
    if (workspace.writable) {
      // A fork's first save records its starting point as its own.
      if (options.from) await workspace.save()
      workspace.unsubscribe = kernel.events.subscribe((event) => {
        if (event.type !== 'fs.change') return
        const changed = event.path === workspace.path || event.path.startsWith(`${workspace.path}/`) || event.to?.startsWith(`${workspace.path}/`)
        if (changed) workspace.schedule()
      })
    }
    return workspace
  }

  /** The head: the last saved tree of the workspace's directory. */
  get head(): string | undefined {
    return this.record.head
  }

  /** Saves now; resolves with the new head. */
  save(): Promise<string | undefined> {
    clearTimeout(this.timer)
    this.timer = undefined
    this.firstChange = undefined
    this.saving = this.saving.then(() => this.write(), () => this.write())
    return this.saving
  }

  /** A snapshot that compaction keeps: saved, and recorded. Returns its hash. */
  async snapshot(): Promise<string> {
    const head = (await this.save()) ?? (await this.kernel.snapshot(this.path))
    if (!this.record.kept.includes(head)) {
      this.record.kept.push(head)
      if (this.writable) await this.writeRecord()
    }
    return head
  }

  /** Stops saving (after a final save of pending changes). */
  async close(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.timer !== undefined) await this.save()
  }

  private schedule(): void {
    const now = Date.now()
    this.firstChange ??= now
    clearTimeout(this.timer)
    const wait = Math.min(this.delay, Math.max(0, this.firstChange + this.maxDelay - now))
    this.timer = setTimeout(() => void this.save(), wait)
  }

  private async write(): Promise<string | undefined> {
    const head = await this.kernel.snapshot(this.path)
    if (!this.writable) return head
    const store = this.kernel.store
    const objects = store.takeUnsaved()
    if (objects.length) {
      try {
        await this.storage.write(`packs/${Date.now().toString(36)}-${(this.packCounter++).toString(36)}-${randomId()}.pack`, encodePack(objects))
      } catch (error) {
        store.unsave(objects.map(([hash]) => hash))
        throw error
      }
    }
    if (head !== this.record.head) {
      this.record.head = head
      await this.writeRecord()
      this.kernel.events.emit({ type: 'workspace.save', name: this.name, head })
    }
    return head
  }

  private async writeRecord(): Promise<void> {
    this.record.saved = Date.now()
    await this.storage.write(recordName(this.name), encoder.encode(JSON.stringify(this.record)))
  }

  private async load(): Promise<void> {
    const store = this.kernel.store
    for (const name of await this.storage.list('packs/')) {
      const pack = await this.storage.read(name)
      if (pack) for (const [hash, bytes] of decodePack(pack)) store.load(hash, bytes)
    }
    const record = await this.storage.read(recordName(this.name))
    if (record) this.record = { kept: [], ...(JSON.parse(decoder.decode(record)) as Partial<WorkspaceRecord>) }
  }
}

/**
 * Rewrites storage as one pack holding what any workspace still reaches (heads and kept
 * snapshots); earlier packs are removed. Run only while nothing else writes to the storage.
 */
export async function compactStorage(storage: WorkspaceStorage, store: MemoryStore): Promise<{ packs: number; objects: number }> {
  const packs = await storage.list('packs/')
  const roots: string[] = []
  for (const name of await storage.list('workspaces/')) {
    const record = await storage.read(name)
    if (!record) continue
    const { head, kept = [] } = JSON.parse(decoder.decode(record)) as Partial<WorkspaceRecord>
    if (head) roots.push(head)
    roots.push(...kept)
  }
  const keep = reachable(store, roots)
  const objects = [...keep].flatMap((hash) => {
    const bytes = store.get(hash)
    return bytes ? [[hash, bytes] as [string, Uint8Array]] : []
  })
  await storage.write(`packs/${Date.now().toString(36)}-compact-${randomId()}.pack`, encodePack(objects))
  for (const name of packs) await storage.remove(name)
  return { packs: packs.length, objects: objects.length }
}

function recordName(name: string): string {
  return `workspaces/${encodeURIComponent(name)}.json`
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/** Storage in memory, for tests and for runtimes that shouldn't persist. */
export function memoryStorage(): WorkspaceStorage & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>()
  return {
    files,
    list: async (prefix) => [...files.keys()].filter((name) => name.startsWith(prefix)).sort(),
    read: async (name) => files.get(name),
    write: async (name, data) => void files.set(name, data.slice()),
    remove: async (name) => void files.delete(name),
  }
}
