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
