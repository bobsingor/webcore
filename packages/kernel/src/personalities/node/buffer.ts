// Minimal Node Buffer: a Uint8Array subclass with string encodings.
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function normalizeEncoding(encoding?: string): string {
  const name = (encoding ?? 'utf8').toLowerCase()
  if (name === 'utf-8') return 'utf8'
  if (name === 'binary') return 'latin1'
  if (name === 'ucs2' || name === 'ucs-2' || name === 'utf-16le') return 'utf16le'
  return name
}

const ENCODINGS = new Set(['utf8', 'hex', 'base64', 'base64url', 'latin1', 'ascii', 'utf16le'])

function encode(text: string, encoding?: string): Uint8Array {
  switch (normalizeEncoding(encoding)) {
    case 'utf8':
      return encoder.encode(text)
    case 'hex': {
      const out = new Uint8Array(text.length >>> 1)
      for (let i = 0; i < out.length; i++) {
        const byte = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16)
        if (Number.isNaN(byte)) return out.subarray(0, i)
        out[i] = byte
      }
      return out
    }
    case 'base64':
    case 'base64url': {
      let clean = text.replace(/[^A-Za-z0-9+/\-_]/g, '').replace(/-/g, '+').replace(/_/g, '/')
      if (clean.length % 4 === 1) clean = clean.slice(0, -1)
      const binary = atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, '='))
      return Uint8Array.from(binary, (char) => char.charCodeAt(0))
    }
    case 'latin1':
    case 'ascii':
      return Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff)
    case 'utf16le': {
      const out = new Uint8Array(text.length * 2)
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        out[i * 2] = code & 0xff
        out[i * 2 + 1] = code >>> 8
      }
      return out
    }
    default:
      throw new TypeError(`Unknown encoding: ${encoding}`)
  }
}

function binaryString(bytes: Uint8Array, mask = 0xff): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...Array.from(bytes.subarray(i, i + 0x8000), (byte) => byte & mask))
  }
  return out
}

function decode(bytes: Uint8Array, encoding?: string): string {
  switch (normalizeEncoding(encoding)) {
    case 'utf8':
      return decoder.decode(bytes)
    case 'hex':
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    case 'base64':
      return btoa(binaryString(bytes))
    case 'base64url':
      return btoa(binaryString(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    case 'latin1':
      return binaryString(bytes)
    case 'ascii':
      return binaryString(bytes, 0x7f)
    case 'utf16le': {
      let out = ''
      for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8))
      return out
    }
    default:
      throw new TypeError(`Unknown encoding: ${encoding}`)
  }
}

export class Buffer extends Uint8Array {
  // Node's Buffer.from accepts many argument shapes, hence the loose signature.
  static override from(value: any, encodingOrOffset?: any, length?: any): any {
    if (typeof value === 'string') return Buffer.wrap(encode(value, encodingOrOffset))
    if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
      const offset = encodingOrOffset ?? 0
      return new Buffer(value as ArrayBuffer, offset, length ?? value.byteLength - offset)
    }
    if (ArrayBuffer.isView(value)) {
      return Buffer.wrap(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice())
    }
    if (value?.type === 'Buffer' && Array.isArray(value.data)) return Buffer.wrap(Uint8Array.from(value.data))
    if (value != null && typeof value.length === 'number') return Buffer.wrap(Uint8Array.from(value))
    throw new TypeError(
      'The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object.',
    )
  }

  /** Views `bytes` as a Buffer without copying. */
  static wrap(bytes: Uint8Array): Buffer {
    return new Buffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)
  }

  static alloc(size: number, fill?: string | number | Uint8Array, encoding?: string): Buffer {
    const buffer = new Buffer(size)
    if (fill !== undefined && fill !== 0) buffer.fill(fill, 0, size, encoding)
    return buffer
  }

  static allocUnsafe(size: number): Buffer {
    return new Buffer(size)
  }

  static isBuffer(value: unknown): value is Buffer {
    return value instanceof Buffer
  }

  static isEncoding(encoding: string): boolean {
    return typeof encoding === 'string' && ENCODINGS.has(normalizeEncoding(encoding))
  }

  static byteLength(value: string | ArrayBufferView | ArrayBuffer, encoding?: string): number {
    return typeof value === 'string' ? encode(value, encoding).length : value.byteLength
  }

  static concat(list: readonly Uint8Array[], totalLength?: number): Buffer {
    const total = totalLength ?? list.reduce((sum, item) => sum + item.length, 0)
    const out = new Buffer(total)
    let offset = 0
    for (const item of list) {
      if (offset >= total) break
      const chunk = item.subarray(0, total - offset)
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }

  static compare(a: Uint8Array, b: Uint8Array): number {
    const length = Math.min(a.length, b.length)
    for (let i = 0; i < length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
  }

  override toString(encoding?: string, start = 0, end = this.length): string {
    return decode(this.subarray(start, end), encoding)
  }

  equals(other: Uint8Array): boolean {
    return Buffer.compare(this, other) === 0
  }

  compare(other: Uint8Array): number {
    return Buffer.compare(this, other)
  }

  write(text: string, offset = 0, length?: number, encoding?: string): number {
    const bytes = encode(text, encoding)
    const n = Math.min(bytes.length, length ?? this.length - offset, this.length - offset)
    this.set(bytes.subarray(0, n), offset)
    return n
  }

  override fill(value: string | number | Uint8Array, start = 0, end = this.length, encoding?: string): this {
    if (typeof value === 'number') return super.fill(value, start, end)
    const pattern = typeof value === 'string' ? encode(value, encoding) : value
    if (!pattern.length) return super.fill(0, start, end)
    for (let i = start; i < end; i++) this[i] = pattern[(i - start) % pattern.length]
    return this
  }

  override slice(start?: number, end?: number): Buffer {
    return this.subarray(start, end) as Buffer
  }

  toJSON(): { type: 'Buffer'; data: number[] } {
    return { type: 'Buffer', data: Array.from(this) }
  }
}
