// M2b: the content-addressed, copy-on-write VFS (ADR-0007) and workspaces that persist /home.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compactStorage, hashBytes, memoryStorage, Workspace, type Kernel } from '../src/index.ts'
import { boot, sh } from './helpers.ts'

let kernel: Kernel
const decoder = new TextDecoder()
const read = (k: Kernel, path: string) => decoder.decode(k.fs.readFile(path))

beforeEach(() => {
  kernel = boot()
})

afterEach(() => {
  kernel.shutdown()
})

describe('snapshots', () => {
  it('hashes trees like git: stable, deduplicated, and incremental', async () => {
    kernel.writeFile('/home/user/a.txt', 'same')
    kernel.writeFile('/home/user/b.txt', 'same')
    kernel.mkdir('/home/user/bin')
    kernel.fs.writeFile('/home/user/bin/run', '#!/bin/sh\n', 0o755)
    kernel.fs.symlink('../a.txt', '/home/user/bin/link')
    const first = await kernel.snapshot()
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(await kernel.snapshot()).toBe(first)
    // Two files with the same contents are one blob: 4 trees/blobs for home, user, bin, plus 3 blobs.
    const objects = kernel.store.count
    kernel.writeFile('/home/user/a.txt', 'changed')
    const second = await kernel.snapshot()
    expect(second).not.toBe(first)
    // One new blob, and new trees for user and home only (bin is unchanged).
    expect(kernel.store.count).toBe(objects + 3)
  })

  it('restores trees copy-on-write, and reports what changed', async () => {
    kernel.writeFile('/home/user/keep.txt', 'v1')
    kernel.mkdir('/home/user/dir')
    kernel.writeFile('/home/user/dir/old.txt', 'old')
    kernel.fs.writeFile('/home/user/tool', 'exec me', 0o755)
    const before = await kernel.snapshot()

    kernel.writeFile('/home/user/keep.txt', 'v2')
    kernel.remove('/home/user/dir', { recursive: true })
    kernel.writeFile('/home/user/new.txt', 'new')
    const changes: string[] = []
    kernel.events.subscribe((event) => {
      if (event.type === 'fs.change') changes.push(`${event.op} ${event.path}`)
    })
    await kernel.restore(before)
    expect(changes.sort()).toEqual(['create /home/user/dir/old.txt', 'mkdir /home/user/dir', 'unlink /home/user/new.txt', 'write /home/user/keep.txt'])
    expect(read(kernel, '/home/user/keep.txt')).toBe('v1')
    expect(kernel.fs.stat(kernel.fs.lookup('/home/user/tool')).mode & 0o777).toBe(0o755)

    // Writing a restored file copies it first: the snapshot keeps its contents.
    expect((await sh(kernel, `node -e "require('fs').appendFileSync('/home/user/keep.txt', '+')" && cat /home/user/keep.txt`)).stdout).toBe('v1+')
    await kernel.restore(before)
    expect(read(kernel, '/home/user/keep.txt')).toBe('v1')
  })

  it('keeps symbolic links and empty directories', async () => {
    kernel.mkdir('/home/user/empty')
    kernel.fs.symlink('/home/user/empty', '/home/user/to-empty')
    const hash = await kernel.snapshot()
    kernel.remove('/home/user/empty')
    kernel.remove('/home/user/to-empty')
    await kernel.restore(hash)
    expect(kernel.fs.readlink('/home/user/to-empty')).toBe('/home/user/empty')
    expect(kernel.fs.lookup('/home/user/to-empty').kind).toBe('dir')
  })
})

describe('workspaces', () => {
  it('persists /home and brings it back in a new kernel', async () => {
    const storage = memoryStorage()
    const workspace = await Workspace.open(kernel, storage, { name: 'project', delay: 10 })
    expect(workspace.head).toBeUndefined()
    await sh(kernel, `node -e "require('fs').mkdirSync('/home/user/app'); require('fs').writeFileSync('/home/user/app/main.js', 'console.log(42)')"`)
    // Saved shortly after the change, without being asked.
    await waitFor(() => workspace.head !== undefined)
    await workspace.close()

    const next = boot()
    try {
      const reopened = await Workspace.open(next, storage, { name: 'project' })
      expect(reopened.head).toBe(workspace.head)
      expect((await sh(next, 'node /home/user/app/main.js')).stdout).toBe('42\n')
      await reopened.close()
    } finally {
      next.shutdown()
    }
  })

  it('forks from a snapshot into a workspace of its own', async () => {
    const storage = memoryStorage()
    const original = await Workspace.open(kernel, storage, { name: 'main' })
    kernel.writeFile('/home/user/shared.txt', 'base')
    const base = await original.snapshot()

    const other = boot()
    try {
      const fork = await Workspace.open(other, storage, { name: 'fork', from: base })
      expect(read(other, '/home/user/shared.txt')).toBe('base')
      other.writeFile('/home/user/shared.txt', 'forked')
      await fork.save()
      expect(read(kernel, '/home/user/shared.txt')).toBe('base')
      // A reader of the same workspace loads it but never writes.
      const third = boot()
      try {
        const reader = await Workspace.open(third, storage, { name: 'fork', writable: false })
        expect(read(third, '/home/user/shared.txt')).toBe('forked')
        const files = storage.files.size
        third.writeFile('/home/user/shared.txt', 'not saved')
        await reader.save()
        expect(storage.files.size).toBe(files)
      } finally {
        third.shutdown()
      }
    } finally {
      other.shutdown()
    }
  })

  it('compacts storage to what workspaces still reach', async () => {
    const storage = memoryStorage()
    const workspace = await Workspace.open(kernel, storage, { name: 'w' })
    kernel.writeFile('/home/user/f.txt', 'kept by a snapshot')
    const kept = await workspace.snapshot()
    for (let i = 0; i < 5; i++) {
      kernel.writeFile('/home/user/f.txt', `draft ${i}`)
      await workspace.save()
    }
    const packs = (await storage.list('packs/')).length
    expect(packs).toBeGreaterThan(5)
    await compactStorage(storage, kernel.store)
    expect(await storage.list('packs/')).toHaveLength(1)

    // Only the head and the kept snapshot survive: drafts 0 to 3 are gone.
    const fresh = boot()
    try {
      const reopened = await Workspace.open(fresh, storage, { name: 'w' })
      const blob = async (text: string) => fresh.store.has(await hashBytes(new TextEncoder().encode(text)))
      expect(await blob('draft 0')).toBe(false)
      expect(await blob('draft 3')).toBe(false)
      expect(await blob('draft 4')).toBe(true)
      expect(await blob('kept by a snapshot')).toBe(true)
      expect(read(fresh, '/home/user/f.txt')).toBe('draft 4')
      await fresh.restore(kept)
      expect(read(fresh, '/home/user/f.txt')).toBe('kept by a snapshot')
      await reopened.close()
    } finally {
      fresh.shutdown()
    }
  })
})

async function waitFor(condition: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
