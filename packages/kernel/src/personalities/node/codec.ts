// Byte/string conversions with Node's encodings, shared by several bindings.
import { host } from './host.ts'

/** Indexes match Node's `enum encoding` (src/node.h) and internalBinding('string_decoder').encodings. */
export const ENCODINGS = ['ascii', 'utf8', 'base64', 'utf16le', 'latin1', 'hex', 'buffer', 'base64url']

const utf8Encoder = new host.TextEncoder()
const utf8Decoder = new host.TextDecoder()

export function encodingName(encoding: unknown): string {
  if (typeof encoding === 'number') return ENCODINGS[encoding] ?? 'utf8'
  const name = String(encoding ?? 'utf8').toLowerCase()
  if (name === 'utf-8') return 'utf8'
  if (name === 'binary') return 'latin1'
  if (name === 'ucs2' || name === 'ucs-2' || name === 'utf-16le') return 'utf16le'
  return name
}

/** Bytes are copied out of shared memory first: TextDecoder rejects shared views. */
function unshared(bytes: Uint8Array): Uint8Array {
  return bytes.buffer instanceof SharedArrayBuffer ? bytes.slice() : bytes
}

export function utf8Length(text: string): number {
  let length = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) length += 1
    else if (code < 0x800) length += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4
        i++
      } else length += 3
    } else length += 3
  }
  return length
}

function base64Bytes(text: string): Uint8Array {
  // Node's decoder is lenient: it skips invalid characters and stops at padding.
  let clean = ''
  for (const char of text) {
    if (char === '=') break
    if (char === '-') clean += '+'
    else if (char === '_') clean += '/'
    else if (/[A-Za-z0-9+/]/.test(char)) clean += char
  }
  if (clean.length % 4 === 1) clean = clean.slice(0, -1)
  const binary = host.atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, '='))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function encode(text: string, encoding: unknown): Uint8Array {
  switch (encodingName(encoding)) {
    case 'utf8':
    case 'buffer':
      return utf8Encoder.encode(text)
    case 'ascii':
    case 'latin1': {
      const out = new Uint8Array(text.length)
      for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
      return out
    }
    case 'utf16le': {
      const out = new Uint8Array(text.length * 2)
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        out[i * 2] = code
        out[i * 2 + 1] = code >>> 8
      }
      return out
    }
    case 'hex': {
      const out = new Uint8Array(text.length >>> 1)
      let i = 0
      for (; i < out.length; i++) {
        const byte = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16)
        if (Number.isNaN(byte) || !/^[0-9a-fA-F]{2}$/.test(text.slice(i * 2, i * 2 + 2))) break
        out[i] = byte
      }
      return out.subarray(0, i)
    }
    case 'base64':
    case 'base64url':
      return base64Bytes(text)
    default:
      return utf8Encoder.encode(text)
  }
}

function binaryString(bytes: Uint8Array, mask = 0xff): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x2000) {
    const chunk = bytes.subarray(i, i + 0x2000)
    out += String.fromCharCode.apply(null, mask === 0xff ? (chunk as unknown as number[]) : Array.from(chunk, (b) => b & mask))
  }
  return out
}

export function decode(bytes: Uint8Array, encoding: unknown): string {
  switch (encodingName(encoding)) {
    case 'utf8':
    case 'buffer':
      return utf8Decoder.decode(unshared(bytes))
    case 'ascii':
      return binaryString(bytes, 0x7f)
    case 'latin1':
      return binaryString(bytes)
    case 'utf16le': {
      let out = ''
      for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8))
      return out
    }
    case 'hex': {
      let out = ''
      for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
      return out
    }
    case 'base64':
      return host.btoa(binaryString(bytes))
    case 'base64url':
      return host.btoa(binaryString(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    default:
      return utf8Decoder.decode(unshared(bytes))
  }
}

/** Views any ArrayBufferView or ArrayBuffer as bytes. */
export function bytesOf(value: ArrayBufferView | ArrayBufferLike): Uint8Array {
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return new Uint8Array(value)
}
