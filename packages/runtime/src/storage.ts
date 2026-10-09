// Persistent storage for workspaces (M2b): the origin private file system (OPFS), under
// webcore/. Web Locks keep two tabs from writing one workspace, and keep compaction from running
// while another runtime uses the storage.
import { compactStorage, Workspace, type Kernel, type WorkspaceStorage } from '@webcore/kernel'

/** Compaction runs at boot once storage holds more packs than this. */
const COMPACT_AFTER_PACKS = 32

export async function opfsStorage(): Promise<WorkspaceStorage> {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('webcore', { create: true })
  const locate = async (name: string) => {
    const slash = name.lastIndexOf('/')
    const folder = await root.getDirectoryHandle(name.slice(0, slash), { create: true })
    return { folder, file: name.slice(slash + 1) }
  }
  return {
    async list(prefix) {
      const { folder } = await locate(`${prefix}x`)
      const names: string[] = []
      for await (const [name, handle] of folder.entries()) if (handle.kind === 'file') names.push(`${prefix}${name}`)
      return names.sort()
    },
    async read(name) {
      const { folder, file } = await locate(name)
      try {
        const handle = await folder.getFileHandle(file)
        return new Uint8Array(await (await handle.getFile()).arrayBuffer())
      } catch (error) {
        if ((error as DOMException).name === 'NotFoundError') return undefined
        throw error
      }
    },
    async write(name, data) {
      const { folder, file } = await locate(name)
      // A writable stream commits on close, so a record is never half written.
      const writable = await (await folder.getFileHandle(file, { create: true })).createWritable()
      await writable.write(data as Uint8Array<ArrayBuffer>)
      await writable.close()
    },
    async remove(name) {
      const { folder, file } = await locate(name)
      await folder.removeEntry(file).catch(() => {})
    },
  }
}

/** Holds a lock until the page goes away; resolves with whether it was granted. */
function holdLock(name: string, mode: LockMode, ifAvailable: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    void navigator.locks.request(name, { mode, ifAvailable }, (lock) => {
      resolve(lock !== null)
      return lock ? new Promise<void>(() => {}) : undefined
    })
  })
}

/**
 * Opens a persistent workspace. The first tab to open a workspace writes it; later ones load it
 * read-only. Storage is compacted first when no other runtime is using it.
 */
export async function openWorkspace(kernel: Kernel, name: string, from?: string): Promise<Workspace> {
  void navigator.storage.persist?.().catch(() => {})
  const storage = await opfsStorage()
  const writable = await holdLock(`webcore:workspace:${name}`, 'exclusive', true)
  let workspace: Workspace | undefined
  await navigator.locks.request('webcore:storage', { ifAvailable: true }, async (lock) => {
    if (!lock) return
    workspace = await Workspace.open(kernel, storage, { name, from, writable })
    if ((await storage.list('packs/')).length > COMPACT_AFTER_PACKS) await compactStorage(storage, kernel.store)
  })
  // While this runtime lives, nobody compacts.
  await holdLock('webcore:storage', 'shared', false)
  return workspace ?? (await Workspace.open(kernel, storage, { name, from, writable }))
}
