// Reader for the node-lib bundle (ADR-0012): [u32 index length][index JSON][UTF-8 sources].
// The bytes live in shared memory; a module's source is decoded only when first compiled.
import { host } from './host.ts'

export type OptionValue = boolean | number | string | string[] | { host: string; port: number } | undefined

interface Index {
  version: string
  entries: [id: string, offset: number, length: number][]
  options: Record<string, OptionValue>
  aliases: Record<string, string[]>
}

export class NodeLib {
  readonly version: string
  readonly ids: string[]
  readonly options: Record<string, OptionValue>
  readonly aliases: Record<string, string[]>
  private readonly bytes: Uint8Array
  private readonly base: number
  private readonly locations = new Map<string, [offset: number, length: number]>()
  private readonly decoder = new host.TextDecoder()

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    const indexLength = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true)
    // slice() copies out of shared memory; TextDecoder rejects shared views.
    const index = JSON.parse(this.decoder.decode(bytes.slice(4, 4 + indexLength))) as Index
    this.base = 4 + indexLength
    this.version = index.version
    this.options = index.options
    this.aliases = index.aliases
    this.ids = index.entries.map(([id]) => id)
    for (const [id, offset, length] of index.entries) this.locations.set(id, [offset, length])
  }

  has(id: string): boolean {
    return this.locations.has(id)
  }

  source(id: string): string {
    const location = this.locations.get(id)
    if (!location) throw new Error(`No such built-in module: ${id}`)
    const start = this.base + location[0]
    return this.decoder.decode(this.bytes.slice(start, start + location[1]))
  }
}
