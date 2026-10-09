// The object store behind snapshots (ADR-0007): immutable byte strings addressed by their
// SHA-256. Blobs are file contents and symbolic link targets; trees are directory listings.

export interface ObjectStore {
  get(hash: string): Uint8Array | undefined
  has(hash: string): boolean
  /** Adds an object. The bytes must not change afterwards. */
  put(hash: string, bytes: Uint8Array): void
}

export class MemoryStore implements ObjectStore {
  private readonly objects = new Map<string, Uint8Array>()
  /** Objects added since the last takeUnsaved(): what persistence still has to write. */
  private unsaved = new Set<string>()

  get count(): number {
    return this.objects.size
  }

  get(hash: string): Uint8Array | undefined {
    return this.objects.get(hash)
  }

  has(hash: string): boolean {
    return this.objects.has(hash)
  }

  put(hash: string, bytes: Uint8Array): void {
    if (this.objects.has(hash)) return
    this.objects.set(hash, bytes)
    this.unsaved.add(hash)
  }

  /** Adds an object that is already persisted. */
  load(hash: string, bytes: Uint8Array): void {
    this.objects.set(hash, bytes)
  }

  /** The objects added since the last call, now considered saved. */
  takeUnsaved(): [hash: string, bytes: Uint8Array][] {
    const taken = [...this.unsaved].map((hash) => [hash, this.objects.get(hash)!] as [string, Uint8Array])
    this.unsaved = new Set()
    return taken
  }

  /** Marks objects as unsaved again, after a failed write. */
  unsave(hashes: string[]): void {
    for (const hash of hashes) if (this.objects.has(hash)) this.unsaved.add(hash)
  }
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += HEX[byte]
  return out
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** SHA-256, hex-encoded. WebCrypto: native speed, in browsers and in Node. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)))
}
