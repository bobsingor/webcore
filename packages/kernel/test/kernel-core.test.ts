import { describe, expect, it } from 'vitest'
import { Errno, KernelError } from '../src/abi/errno.ts'
import { MemFS } from '../src/kernel/vfs.ts'
import { Pipe } from '../src/kernel/pipe.ts'

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const bytes = (value: string) => new TextEncoder().encode(value)

function errnoOf(fn: () => unknown): number | undefined {
  try {
    fn()
  } catch (error) {
    if (error instanceof KernelError) return error.errno
    throw error
  }
  return undefined
}

describe('MemFS', () => {
  it('creates, writes, grows and reads files', () => {
    const fs = new MemFS()
    fs.mkdirp('/a/b')
    const node = fs.writeFile('/a/b/file.txt', 'hello')
    MemFS.writeAt(node, 5, bytes(' world'))
    expect(text(fs.readFile('/a/b/file.txt'))).toBe('hello world')
    expect(fs.stat(node).size).toBe(11)
    MemFS.truncate(node, 5)
    expect(text(fs.readFile('/a/b/file.txt'))).toBe('hello')
  })

  it('reports Linux errno values', () => {
    const fs = new MemFS()
    fs.mkdirp('/dir/sub')
    fs.writeFile('/file', 'x')
    expect(errnoOf(() => fs.lookup('/missing'))).toBe(Errno.ENOENT)
    expect(errnoOf(() => fs.lookup('/file/child'))).toBe(Errno.ENOTDIR)
    expect(errnoOf(() => fs.mkdir('/dir'))).toBe(Errno.EEXIST)
    expect(errnoOf(() => fs.rmdir('/dir'))).toBe(Errno.ENOTEMPTY)
    expect(errnoOf(() => fs.unlink('/dir'))).toBe(Errno.EISDIR)
  })

  it('renames, and refuses to move a directory into itself', () => {
    const fs = new MemFS()
    fs.mkdirp('/a/b')
    fs.writeFile('/a/b/f', 'data')
    fs.rename('/a/b', '/c')
    expect(text(fs.readFile('/c/f'))).toBe('data')
    expect(errnoOf(() => fs.rename('/c', '/c/inner'))).toBe(Errno.EINVAL)
    expect(fs.readdir(fs.root).map((entry) => entry.name)).toEqual(['a', 'c'])
  })
})

describe('MemFS links', () => {
  it('follows symbolic links, relative ones from the link, .. physically', () => {
    const fs = new MemFS()
    fs.mkdirp('/pkg/bin')
    fs.writeFile('/pkg/bin/cli.js', 'cli')
    fs.mkdirp('/app/node_modules/.bin')
    fs.symlink('/pkg', '/app/node_modules/pkg')
    fs.symlink('../pkg/bin/cli.js', '/app/node_modules/.bin/cli')
    expect(text(fs.readFile('/app/node_modules/.bin/cli'))).toBe('cli')
    expect(fs.realpath('/app/node_modules/.bin/cli')).toBe('/pkg/bin/cli.js')
    expect(fs.lookup('/app/node_modules/.bin/cli', false).kind).toBe('symlink')
    expect(fs.readlink('/app/node_modules/.bin/cli')).toBe('../pkg/bin/cli.js')
    expect(fs.stat(fs.lookup('/app/node_modules/.bin/cli', false))).toMatchObject({ type: 'symlink', size: 17 })
    expect(fs.readdir(fs.lookup('/app/node_modules') as never).map((entry) => [entry.name, entry.type])).toEqual([
      ['.bin', 'dir'],
      ['pkg', 'symlink'],
    ])
    // A file created through a linked directory lands in the target.
    fs.writeFile('/app/node_modules/pkg/new.txt', 'x')
    expect(fs.lookup('/pkg/new.txt').kind).toBe('file')
    fs.mkdirp('/app/node_modules/pkg/deep/dir')
    expect(fs.lookup('/pkg/deep/dir').kind).toBe('dir')
    // Removing the link leaves the target alone.
    fs.unlink('/app/node_modules/pkg')
    expect(fs.lookup('/pkg/bin/cli.js').kind).toBe('file')
  })

  it('detects loops and dangling links, and refuses to readlink a file', () => {
    const fs = new MemFS()
    fs.symlink('/b', '/a')
    fs.symlink('/a', '/b')
    fs.symlink('/nowhere', '/dangling')
    fs.writeFile('/file', 'x')
    expect(errnoOf(() => fs.lookup('/a'))).toBe(Errno.ELOOP)
    expect(errnoOf(() => fs.lookup('/dangling'))).toBe(Errno.ENOENT)
    expect(fs.tryLookup('/dangling')).toBeUndefined()
    expect(fs.tryLookup('/dangling', false)?.kind).toBe('symlink')
    expect(errnoOf(() => fs.readlink('/file'))).toBe(Errno.EINVAL)
  })

  it('counts hard links', () => {
    const fs = new MemFS()
    const node = fs.writeFile('/one', 'shared')
    fs.hardlink('/one', '/two')
    expect(fs.stat(node).nlink).toBe(2)
    fs.unlink('/one')
    expect(text(fs.readFile('/two'))).toBe('shared')
    expect(fs.stat(node).nlink).toBe(1)
  })
})

describe('Pipe', () => {
  it('blocks readers until data arrives and signals EOF after the writer closes', async () => {
    const pipe = new Pipe()
    const first = pipe.read(100)
    await pipe.write(bytes('abc'))
    expect(text(await first)).toBe('abc')
    const second = pipe.read(100)
    pipe.closeWrite()
    expect((await second).length).toBe(0)
  })

  it('fails writes with EPIPE once the reader is gone', async () => {
    const pipe = new Pipe()
    pipe.closeRead()
    await expect(pipe.write(bytes('x'))).rejects.toMatchObject({ errno: Errno.EPIPE })
  })

  it('applies backpressure above capacity', async () => {
    const pipe = new Pipe(4)
    await pipe.write(bytes('12345'))
    let written = false
    const pending = pipe.write(bytes('6')).then(() => (written = true))
    await Promise.resolve()
    expect(written).toBe(false)
    expect(text(await pipe.read(5))).toBe('12345')
    await pending
    expect(written).toBe(true)
  })

  it('cancels a blocked read when its process is aborted', async () => {
    const pipe = new Pipe()
    const abort = new AbortController()
    const read = pipe.read(10, abort.signal)
    abort.abort()
    await expect(read).rejects.toMatchObject({ errno: Errno.EINTR })
  })
})
