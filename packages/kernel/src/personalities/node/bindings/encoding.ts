// buffer, encoding_binding, string_decoder: Node's C++ string and byte helpers.
import { bytesOf, decode, encode, ENCODINGS, utf8Length } from '../codec.ts'
import type { Realm } from '../realm.ts'
import { host } from '../host.ts'

const utf8Decoder = new host.TextDecoder()
const fatalUtf8Decoder = new host.TextDecoder('utf-8', { fatal: true })

function clampRange(length: number, start: unknown, end: unknown): [number, number] {
  const s = Math.max(0, Math.min(length, Number(start) || 0))
  const e = end === undefined ? length : Math.max(s, Math.min(length, Number(end) || 0))
  return [s, e]
}

function writeInto(buf: Uint8Array, bytes: Uint8Array, offset: unknown, length: unknown): number {
  const start = Number(offset) || 0
  const room = Math.max(0, buf.length - start)
  const max = length === undefined ? room : Math.min(room, Number(length))
  let n = Math.min(bytes.length, max)
  // UTF-8 writes never split a character (as V8's WriteUtf8 does).
  if (n < bytes.length) while (n > 0 && (bytes[n] & 0xc0) === 0x80) n--
  buf.set(bytes.subarray(0, n), start)
  return n
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, byteOffset: number, forward: boolean): number {
  const length = haystack.length
  let offset = byteOffset < 0 ? Math.max(0, length + byteOffset) : byteOffset
  if (needle.length === 0) return Math.min(offset, length)
  if (forward) {
    outer: for (let i = offset; i <= length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
      return i
    }
    return -1
  }
  offset = Math.min(offset, length - needle.length)
  outer: for (let i = offset; i >= 0; i--) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

export function encodingBindings() {
  return {
    buffer: (realm: Realm) => {
      const binding: Record<string, unknown> = {
        kMaxLength: Number.MAX_SAFE_INTEGER,
        kStringMaxLength: 2 ** 29 - 24,
        setBufferPrototype: (prototype: object) => (realm.bufferPrototype = prototype),
        createUnsafeArrayBuffer: (size: number) => new ArrayBuffer(size),
        setDetachKey: () => {},
        byteLengthUtf8: (text: string) => utf8Length(text),
        compare: (a: Uint8Array, b: Uint8Array) => compareBytes(bytesOf(a), bytesOf(b)),
        compareOffset: (
          source: Uint8Array,
          target: Uint8Array,
          targetStart: number,
          sourceStart: number,
          targetEnd: number,
          sourceEnd: number,
        ) => compareBytes(bytesOf(source).subarray(sourceStart, sourceEnd), bytesOf(target).subarray(targetStart, targetEnd)),
        copy: (source: Uint8Array, target: Uint8Array, targetStart: number, sourceStart: number, count: number) => {
          bytesOf(target).set(bytesOf(source).subarray(sourceStart, sourceStart + count), targetStart)
          return count
        },
        copyArrayBuffer: (destination: ArrayBuffer, destinationOffset: number, source: ArrayBuffer, sourceOffset: number, count: number) => {
          new Uint8Array(destination, destinationOffset, count).set(new Uint8Array(source, sourceOffset, count))
        },
        fill: (buf: Uint8Array, value: unknown, offset: number, end: number, encoding?: string) => {
          if (end > buf.length || offset > end) return -2
          const pattern = typeof value === 'string' ? encode(value, encoding) : bytesOf(value as Uint8Array)
          if (!pattern.length) return -1
          const bytes = bytesOf(buf)
          for (let i = offset, j = 0; i < end; i++, j = (j + 1) % pattern.length) bytes[i] = pattern[j]
          return undefined
        },
        indexOfString: (buf: Uint8Array, value: string, byteOffset: number, encoding: number, forward: boolean) =>
          indexOfBytes(bytesOf(buf), encode(value, encoding), byteOffset, forward),
        indexOfBuffer: (buf: Uint8Array, value: Uint8Array, byteOffset: number, _encoding: number, forward: boolean) =>
          indexOfBytes(bytesOf(buf), bytesOf(value), byteOffset, forward),
        indexOfNumber: (buf: Uint8Array, value: number, byteOffset: number, forward: boolean) =>
          indexOfBytes(bytesOf(buf), Uint8Array.of(value & 0xff), byteOffset, forward),
        swap16: (buf: Uint8Array) => swap(buf, 2),
        swap32: (buf: Uint8Array) => swap(buf, 4),
        swap64: (buf: Uint8Array) => swap(buf, 8),
        isUtf8: (input: ArrayBufferView | ArrayBuffer) => {
          try {
            fatalUtf8Decoder.decode(bytesOf(input).slice())
            return true
          } catch {
            return false
          }
        },
        isAscii: (input: ArrayBufferView | ArrayBuffer) => bytesOf(input).every((byte) => byte < 0x80),
        atob: (input: string) => {
          const clean = input.replace(/[\t\n\f\r ]/g, '')
          if (/[^A-Za-z0-9+/=]/.test(clean)) return -2
          try {
            return host.atob(clean)
          } catch {
            return clean.replace(/=+$/, '').length % 4 === 1 ? -1 : -2
          }
        },
        btoa: (input: string) => {
          for (let i = 0; i < input.length; i++) if (input.charCodeAt(i) > 0xff) return -1
          return host.btoa(input)
        },
      }
      for (const name of ENCODINGS) {
        if (name === 'buffer') continue
        const prefix = name === 'utf16le' ? 'ucs2' : name
        binding[`${prefix}Slice`] = (buf: Uint8Array, start: unknown, end: unknown) => {
          const bytes = bytesOf(buf)
          const [s, e] = clampRange(bytes.length, start, end)
          return decode(bytes.subarray(s, e), name)
        }
        const write = (buf: Uint8Array, text: string, offset: unknown, length: unknown) =>
          writeInto(bytesOf(buf), encode(text, name), offset, length)
        binding[`${prefix}Write`] = write
        binding[`${prefix}WriteStatic`] = write
      }
      return binding
    },

    encoding_binding: () => {
      const encodeIntoResults = new Uint32Array(2)
      return {
      encodeIntoResults,
      encodeInto: (source: string, dest: Uint8Array) => {
        const { read = 0, written = 0 } = new host.TextEncoder().encodeInto(source, dest)
        encodeIntoResults[0] = read
        encodeIntoResults[1] = written
      },
      encodeUtf8String: (text: string) => new host.TextEncoder().encode(text),
      decodeUTF8: (input: ArrayBufferView | ArrayBuffer, ignoreBOM?: boolean, fatal?: boolean) => {
        const bytes = bytesOf(input).slice()
        return new host.TextDecoder('utf-8', { ignoreBOM: Boolean(ignoreBOM), fatal: Boolean(fatal) }).decode(bytes)
      },
      decodeLatin1: (input: ArrayBufferView | ArrayBuffer) => decode(bytesOf(input), 'latin1'),
      toASCII: (input: string) => {
        try {
          return new host.URL(`http://${input}`).hostname
        } catch {
          return input
        }
      },
      toUnicode: (input: string) => input,
      }
    },

    // State layout (src/string_decoder.h): [0..4) incomplete bytes, 4 missing, 5 buffered, 6 encoding.
    string_decoder: () => {
      const kIncompleteCharactersStart = 0
      const kMissingBytes = 4
      const kBufferedBytes = 5
      const kEncodingField = 6
      const pending = new WeakMap<Uint8Array, Uint8Array>()

      const charLength = (byte: number): number =>
        byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1

      const decodeChunk = (state: Uint8Array, input: Uint8Array): string => {
        const encoding = ENCODINGS[state[kEncodingField]]
        const previous = pending.get(state) ?? new Uint8Array(0)
        const bytes = new Uint8Array(previous.length + input.length)
        bytes.set(previous)
        bytes.set(input, previous.length)
        // Keep an incomplete trailing sequence for the next call.
        let keep = 0
        if (encoding === 'utf8') {
          for (let back = 1; back <= Math.min(4, bytes.length); back++) {
            const byte = bytes[bytes.length - back]
            if ((byte & 0xc0) === 0x80) continue
            if (byte >= 0xc0 && charLength(byte) > back) keep = back
            break
          }
        } else if (encoding === 'utf16le') {
          keep = bytes.length % 2
          if (!keep && bytes.length >= 2) {
            const last = bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8)
            if (last >= 0xd800 && last <= 0xdbff) keep = 2
          }
        } else if (encoding === 'base64' || encoding === 'base64url') {
          keep = bytes.length % 3
        }
        const complete = bytes.subarray(0, bytes.length - keep)
        const rest = bytes.slice(bytes.length - keep)
        pending.set(state, rest)
        state.set(rest.subarray(0, 4), kIncompleteCharactersStart)
        state[kBufferedBytes] = rest.length
        state[kMissingBytes] = rest.length && encoding === 'utf8' ? charLength(rest[0]) - rest.length : 0
        return encoding === 'utf8' ? utf8Decoder.decode(complete.slice()) : decode(complete, encoding)
      }

      return {
        encodings: ENCODINGS,
        kIncompleteCharactersStart,
        kIncompleteCharactersEnd: 4,
        kMissingBytes,
        kBufferedBytes,
        kEncodingField,
        kNumFields: 7,
        kSize: 7,
        decode: (state: Uint8Array, input: ArrayBufferView) => decodeChunk(state, bytesOf(input)),
        flush: (state: Uint8Array) => {
          const rest = pending.get(state) ?? new Uint8Array(0)
          pending.delete(state)
          state[kBufferedBytes] = 0
          state[kMissingBytes] = 0
          const encoding = ENCODINGS[state[kEncodingField]]
          return encoding === 'utf8' ? utf8Decoder.decode(rest) : decode(rest, encoding)
        },
      }
    },
  }
}

function swap(buf: Uint8Array, size: number): void {
  const bytes = bytesOf(buf)
  for (let i = 0; i + size <= bytes.length; i += size) bytes.subarray(i, i + size).reverse()
}

