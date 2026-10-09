// Gzipped tarballs (npm packages) → kernel filesystem. Uses DecompressionStream, available in
// browsers, Node, Deno and Bun. The package installer (M1d) builds on this.
import type { Kernel } from '../kernel/kernel.ts'
import { dirname, resolve } from '../kernel/path.ts'

export interface TarEntry {
  path: string
  type: 'file' | 'directory'
  mode: number
  data: Uint8Array
}

const decoder = new TextDecoder()

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function field(block: Uint8Array, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return decoder.decode(end === -1 ? raw : raw.subarray(0, end))
}

function octal(block: Uint8Array, offset: number, length: number): number {
  return Number.parseInt(field(block, offset, length).trim() || '0', 8)
}

/** Parses a (ustar/pax/GNU) tar archive. Only regular files and directories are returned. */
export function parseTar(archive: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  let longName: string | undefined
  let paxPath: string | undefined
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156] || 48)
    const data = archive.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512

    if (type === 'L') {
      longName = decoder.decode(data).replace(/\0.*$/s, '')
      continue
    }
    if (type === 'x') {
      for (const record of decoder.decode(data).split('\n')) {
        const match = /^\d+ path=(.*)$/.exec(record)
        if (match) paxPath = match[1]
      }
      continue
    }
    if (type === 'g') continue

    const prefix = field(header, 345, 155)
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100))
    paxPath = longName = undefined
    if (type === '0' || type === '7') entries.push({ path: name, type: 'file', mode: octal(header, 100, 8), data: data.slice() })
    else if (type === '5') entries.push({ path: name, type: 'directory', mode: octal(header, 100, 8), data: new Uint8Array(0) })
  }
  return entries
}

/**
 * Unpacks a gzipped npm tarball into `destination`, dropping its leading directory
 * (`package/` for npm). Returns the number of files written.
 */
export async function installTarball(kernel: Kernel, tarball: Uint8Array, destination: string): Promise<number> {
  const entries = parseTar(await gunzip(tarball))
  let files = 0
  for (const entry of entries) {
    const relative = entry.path.split('/').slice(1).join('/')
    if (!relative || relative.split('/').includes('..')) continue
    const target = resolve(destination, relative)
    if (entry.type === 'directory') {
      kernel.fs.mkdirp(target)
      continue
    }
    kernel.fs.mkdirp(dirname(target))
    kernel.fs.writeFile(target, entry.data, entry.mode & 0o777 || 0o644)
    files++
  }
  return files
}
