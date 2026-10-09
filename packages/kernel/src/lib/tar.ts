// Tar archives and gzip, for npm packages. DecompressionStream is available in browsers, Node, Deno
// and Bun, and runs natively.

export interface TarEntry {
  path: string
  type: 'file' | 'directory'
  mode: number
  data: Uint8Array
}

const decoder = new TextDecoder()

export function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b
}

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
