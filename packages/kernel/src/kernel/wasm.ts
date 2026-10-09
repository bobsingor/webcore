// What the kernel reads from a Wasm binary before running it. WebAssembly.Module.imports() names a
// module's imports but not a memory import's limits, which whoever creates the memory needs: WASIX
// programs import a shared memory rather than defining their own.

export interface MemoryImport {
  module: string
  name: string
  /** In 64 KiB pages. */
  initial: number
  maximum?: number
  shared: boolean
}

const decoder = new TextDecoder()

/** The memory `bytes` imports, from its import section. */
export function memoryImport(bytes: Uint8Array): MemoryImport | undefined {
  let offset = 8
  const leb = (): number => {
    let result = 0
    let scale = 1
    let byte: number
    do {
      byte = bytes[offset++]
      result += (byte & 0x7f) * scale
      scale *= 128
    } while (byte & 0x80)
    return result
  }
  const name = (): string => {
    const length = leb()
    const text = decoder.decode(bytes.subarray(offset, offset + length))
    offset += length
    return text
  }
  while (offset < bytes.length) {
    const section = bytes[offset++]
    const size = leb()
    if (section !== 2) {
      offset += size
      continue
    }
    for (let count = leb(); count > 0; count--) {
      const module = name()
      const field = name()
      const kind = bytes[offset++]
      if (kind === 0) leb()
      else if (kind === 1 || kind === 2) {
        if (kind === 1) offset++ // the table's element type
        const flags = bytes[offset++]
        const initial = leb()
        const maximum = flags & 1 ? leb() : undefined
        if (kind === 2) return { module, name: field, initial, maximum, shared: (flags & 2) !== 0 }
      } else if (kind === 3) offset += 2 // a global's type and mutability
      else if (kind === 4) {
        offset++ // a tag's attribute
        leb()
      } else return undefined
    }
    return undefined
  }
  return undefined
}
