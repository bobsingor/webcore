// C strings as JavaScript strings, losslessly. argv and the environment are bytes, usually UTF-8
// but not necessarily: BusyBox marks a re-executed argv[0] by setting its first byte's high bit.
// Like Python's surrogateescape, a byte that isn't part of valid UTF-8 becomes a lone surrogate
// (U+DC00 + byte, so U+DC80 to U+DCFF), and encoding turns it back into that byte.

const strict = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

export function decodeBytes(bytes: Uint8Array): string {
  try {
    return strict.decode(bytes)
  } catch {
    let text = ''
    for (let i = 0; i < bytes.length; ) {
      const length = sequenceLength(bytes, i)
      if (length) {
        text += strict.decode(bytes.subarray(i, i + length))
        i += length
      } else text += String.fromCharCode(0xdc00 + bytes[i++])
    }
    return text
  }
}

export function encodeBytes(text: string): Uint8Array {
  if (!/[\udc80-\udcff]/.test(text)) return encoder.encode(text)
  const out: number[] = []
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (char.length === 1 && code >= 0xdc80 && code <= 0xdcff) out.push(code - 0xdc00)
    else out.push(...encoder.encode(char))
  }
  return Uint8Array.from(out)
}

/** The length of the valid UTF-8 sequence at `i`, or 0. */
function sequenceLength(bytes: Uint8Array, i: number): number {
  const lead = bytes[i]
  const length = lead < 0x80 ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0
  if (!length || i + length > bytes.length) return 0
  try {
    strict.decode(bytes.subarray(i, i + length))
    return length
  } catch {
    return 0
  }
}
