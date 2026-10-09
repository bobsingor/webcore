// serdes (src/node_serdes.cc): v8.Serializer and v8.Deserializer. V8's ValueSerializer is engine
// internals that browsers don't expose, so this implements its wire format (version 15) itself,
// value for value, with Node's delegate hooks: _writeHostObject/_readHostObject (Node writes
// typed arrays as host objects), _getDataCloneError and _getSharedArrayBufferId.
//
// Where V8's bytes depend on how it stores a value internally, this picks the common case:
// integers in the int32 range are written as int32 (V8 writes doubles for numbers it stores as
// doubles), strings are one-byte when every character fits, and arrays are dense when they have
// no holes. Every form is read back.
import type { Realm } from '../realm.ts'
import { types } from './support.ts'

const LATEST_VERSION = 15
const MINIMUM_VERSION = 13

const tag = (char: string) => char.charCodeAt(0)
const T = {
  version: 0xff,
  padding: 0,
  verifyObjectCount: tag('?'),
  theHole: tag('-'),
  undefined: tag('_'),
  null: tag('0'),
  true: tag('T'),
  false: tag('F'),
  int32: tag('I'),
  uint32: tag('U'),
  double: tag('N'),
  bigint: tag('Z'),
  utf8String: tag('S'),
  oneByteString: tag('"'),
  twoByteString: tag('c'),
  objectReference: tag('^'),
  beginObject: tag('o'),
  endObject: tag('{'),
  beginSparseArray: tag('a'),
  endSparseArray: tag('@'),
  beginDenseArray: tag('A'),
  endDenseArray: tag('$'),
  date: tag('D'),
  trueObject: tag('y'),
  falseObject: tag('x'),
  numberObject: tag('n'),
  bigintObject: tag('z'),
  stringObject: tag('s'),
  regExp: tag('R'),
  beginMap: tag(';'),
  endMap: tag(':'),
  beginSet: tag("'"),
  endSet: tag(','),
  arrayBuffer: tag('B'),
  resizableArrayBuffer: tag('~'),
  arrayBufferTransfer: tag('t'),
  arrayBufferView: tag('V'),
  sharedArrayBuffer: tag('u'),
  hostObject: tag('\\'),
  error: tag('r'),
}

const ERROR_TAGS: Record<string, number> = {
  EvalError: tag('E'),
  RangeError: tag('R'),
  ReferenceError: tag('F'),
  SyntaxError: tag('S'),
  TypeError: tag('T'),
  URIError: tag('U'),
}
const E = { message: tag('m'), cause: tag('c'), stack: tag('s'), end: tag('.') }

type ViewConstructor = new (buffer: ArrayBufferLike, byteOffset: number, length: number) => ArrayBufferView
const VIEW_TAGS: [string, number][] = [
  ['Int8Array', tag('b')],
  ['Uint8Array', tag('B')],
  ['Uint8ClampedArray', tag('C')],
  ['Int16Array', tag('w')],
  ['Uint16Array', tag('W')],
  ['Int32Array', tag('d')],
  ['Uint32Array', tag('D')],
  ['Float16Array', tag('h')],
  ['Float32Array', tag('f')],
  ['Float64Array', tag('F')],
  ['BigInt64Array', tag('q')],
  ['BigUint64Array', tag('Q')],
  ['DataView', tag('?')],
]

const REGEXP_FLAGS: [string, number][] = [
  ['g', 1],
  ['i', 2],
  ['m', 4],
  ['y', 8],
  ['u', 16],
  ['s', 32],
  ['l', 64],
  ['d', 128],
  ['v', 256],
]

const getter = (proto: object, key: string) => Object.getOwnPropertyDescriptor(proto, key)!.get! as (this: unknown) => unknown
const regExpSource = getter(RegExp.prototype, 'source')
const regExpFlags = getter(RegExp.prototype, 'flags')
const typedArrayTag = getter(Object.getPrototypeOf(Uint8Array.prototype) as object, Symbol.toStringTag as unknown as string)
const hasOwn = (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key)
const isIndex = (key: string) => /^(?:0|[1-9]\d{0,9})$/.test(key) && Number(key) <= 4294967294

/** V8's NoSideEffectsToString, as used in "… could not be cloned." */
function describe(value: unknown): string {
  if (typeof value === 'function') return Function.prototype.toString.call(value)
  if (typeof value === 'symbol') return value.toString()
  let name = 'Object'
  try {
    const constructor = (Object.getPrototypeOf(value) as { constructor?: unknown } | null)?.constructor
    if (typeof constructor === 'function' && constructor.name) name = constructor.name
  } catch {
    // A proxy or a throwing getter: V8 says Object.
  }
  return `#<${name}>`
}

/** Values V8 refuses: callables and exotic objects other than the ones it knows how to write. */
function isUncloneable(value: object): boolean {
  return (
    types.isPromise(value) ||
    types.isWeakMap(value) ||
    types.isWeakSet(value) ||
    types.isGeneratorObject(value) ||
    types.isMapIterator(value) ||
    types.isSetIterator(value) ||
    types.isArgumentsObject(value) ||
    types.isModuleNamespaceObject(value) ||
    types.isSymbolObject(value) ||
    (typeof WeakRef === 'function' && brand(() => WeakRef.prototype.deref.call(value))) ||
    (typeof WebAssembly === 'object' && (value instanceof WebAssembly.Module || value instanceof WebAssembly.Memory))
  )
}

function brand(check: () => unknown): boolean {
  try {
    check()
    return true
  } catch {
    return false
  }
}

const invalidArgType = (message: string) => Object.assign(new TypeError(message), { code: 'ERR_INVALID_ARG_TYPE' })

class Writer {
  bytes = new Uint8Array(64)
  length = 0

  private reserve(count: number): void {
    if (this.length + count <= this.bytes.length) return
    let size = this.bytes.length * 2
    while (size < this.length + count) size *= 2
    const grown = new Uint8Array(size)
    grown.set(this.bytes.subarray(0, this.length))
    this.bytes = grown
  }

  byte(value: number): void {
    this.reserve(1)
    this.bytes[this.length++] = value
  }

  varint(value: number | bigint): void {
    if (typeof value === 'bigint') {
      do {
        let byte = Number(value & 0x7fn)
        value >>= 7n
        if (value) byte |= 0x80
        this.byte(byte)
      } while (value)
      return
    }
    do {
      let byte = value % 128
      value = Math.floor(value / 128)
      if (value) byte |= 0x80
      this.byte(byte)
    } while (value)
  }

  double(value: number): void {
    this.reserve(8)
    new DataView(this.bytes.buffer).setFloat64(this.length, value, true)
    this.length += 8
  }

  raw(bytes: Uint8Array): void {
    this.reserve(bytes.length)
    this.bytes.set(bytes, this.length)
    this.length += bytes.length
  }

  take(): Uint8Array {
    const out = this.bytes.slice(0, this.length)
    this.bytes = new Uint8Array(64)
    this.length = 0
    return out
  }
}

const varintSize = (value: number) => {
  let size = 1
  while (value >= 128) {
    value = Math.floor(value / 128)
    size++
  }
  return size
}

export function serdesBindings() {
  return {
    serdes: (realm: Realm) => {
      class Serializer {
        #out = new Writer()
        #ids = new Map<object, number>()
        #nextId = 0
        #transfers = new Map<ArrayBuffer, number>()
        #viewsAsHostObjects = false

        writeHeader(): void {
          this.#out.byte(T.version)
          this.#out.varint(LATEST_VERSION)
        }

        writeValue(value: unknown): boolean {
          this.#write(value)
          return true
        }

        releaseBuffer(): Uint8Array {
          return realm.newBuffer(this.#out.take())
        }

        transferArrayBuffer(id: number, arrayBuffer: unknown): void {
          if (!types.isArrayBuffer(arrayBuffer)) throw invalidArgType('arrayBuffer must be an ArrayBuffer')
          this.#transfers.set(arrayBuffer as ArrayBuffer, id >>> 0)
        }

        writeUint32(value: number): void {
          this.#out.varint(value >>> 0)
        }

        writeUint64(hi: number, lo: number): void {
          this.#out.varint((BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0))
        }

        writeDouble(value: number): void {
          this.#out.double(Number(value))
        }

        writeRawBytes(source: unknown): void {
          if (!ArrayBuffer.isView(source)) throw invalidArgType('source must be a TypedArray or a DataView')
          this.#out.raw(new Uint8Array(source.buffer, source.byteOffset, source.byteLength))
        }

        _setTreatArrayBufferViewsAsHostObjects(value: unknown): void {
          this.#viewsAsHostObjects = Boolean(value)
        }

        #cloneError(message: string): Error {
          const make = (this as unknown as { _getDataCloneError?: (message: string) => Error })._getDataCloneError
          return typeof make === 'function' ? make.call(this, message) : new Error(message)
        }

        #write(value: unknown): void {
          const out = this.#out
          switch (typeof value) {
            case 'undefined':
              return out.byte(T.undefined)
            case 'boolean':
              return out.byte(value ? T.true : T.false)
            case 'number':
              if (Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff && !Object.is(value, -0)) {
                out.byte(T.int32)
                return out.varint(((value << 1) ^ (value >> 31)) >>> 0)
              }
              out.byte(T.double)
              return out.double(value)
            case 'bigint':
              out.byte(T.bigint)
              return this.#writeBigIntContents(value)
            case 'string':
              return this.#writeString(value)
            case 'object':
              if (value === null) return out.byte(T.null)
              // A view's buffer is written first, before the view gets its id.
              if (ArrayBuffer.isView(value) && !this.#ids.has(value) && !this.#viewsAsHostObjects) {
                this.#writeReceiver(value.buffer)
              }
              return this.#writeReceiver(value)
            default:
              throw this.#cloneError(`${describe(value)} could not be cloned.`)
          }
        }

        #writeReceiver(value: object): void {
          const out = this.#out
          const id = this.#ids.get(value)
          if (id !== undefined) {
            out.byte(T.objectReference)
            return out.varint(id)
          }
          this.#ids.set(value, this.#nextId++)
          if (Array.isArray(value)) return this.#writeArray(value)
          if (ArrayBuffer.isView(value)) return this.#viewsAsHostObjects ? this.#writeHostObject(value) : this.#writeView(value)
          if (types.isAnyArrayBuffer(value)) return this.#writeArrayBuffer(value as ArrayBuffer)
          if (types.isDate(value)) {
            out.byte(T.date)
            return out.double(Date.prototype.getTime.call(value))
          }
          if (types.isRegExp(value)) {
            out.byte(T.regExp)
            this.#writeString(regExpSource.call(value) as string)
            const flags = regExpFlags.call(value) as string
            return out.varint(REGEXP_FLAGS.reduce((bits, [flag, bit]) => (flags.includes(flag) ? bits | bit : bits), 0))
          }
          if (types.isMap(value)) {
            out.byte(T.beginMap)
            const entries = [...Map.prototype.entries.call(value)] as [unknown, unknown][]
            for (const [key, item] of entries) {
              this.#write(key)
              this.#write(item)
            }
            out.byte(T.endMap)
            return out.varint(entries.length * 2)
          }
          if (types.isSet(value)) {
            out.byte(T.beginSet)
            const items = [...Set.prototype.values.call(value)] as unknown[]
            for (const item of items) this.#write(item)
            out.byte(T.endSet)
            return out.varint(items.length)
          }
          if (types.isNativeError(value)) return this.#writeError(value as Error)
          if (types.isBooleanObject(value)) return out.byte(Boolean.prototype.valueOf.call(value) ? T.trueObject : T.falseObject)
          if (types.isNumberObject(value)) {
            out.byte(T.numberObject)
            return out.double(Number.prototype.valueOf.call(value))
          }
          if (types.isBigIntObject(value)) {
            out.byte(T.bigintObject)
            return this.#writeBigIntContents(BigInt.prototype.valueOf.call(value))
          }
          if (types.isStringObject(value)) {
            out.byte(T.stringObject)
            return this.#writeString(String.prototype.valueOf.call(value))
          }
          if (typeof value === 'function' || isUncloneable(value)) throw this.#cloneError(`${describe(value)} could not be cloned.`)
          out.byte(T.beginObject)
          const count = this.#writeProperties(value, Object.keys(value))
          out.byte(T.endObject)
          out.varint(count)
        }

        /** Key/value pairs; index keys are written as numbers. Returns how many were written. */
        #writeProperties(object: object, keys: string[]): number {
          let count = 0
          for (const key of keys) {
            // A getter may have deleted a later property.
            if (!hasOwn(object, key)) continue
            const value = (object as Record<string, unknown>)[key]
            this.#write(isIndex(key) ? Number(key) : key)
            this.#write(value)
            count++
          }
          return count
        }

        #writeArray(array: unknown[]): void {
          const out = this.#out
          const length = array.length
          let dense = true
          for (let i = 0; i < length && dense; i++) dense = hasOwn(array, i)
          if (dense) {
            out.byte(T.beginDenseArray)
            out.varint(length)
            for (let i = 0; i < length; i++) {
              if (hasOwn(array, i)) this.#write(array[i])
              else out.byte(T.theHole)
            }
            const count = this.#writeProperties(array, Object.keys(array).filter((key) => !isIndex(key) || Number(key) >= length))
            out.byte(T.endDenseArray)
            out.varint(count)
            return out.varint(length)
          }
          out.byte(T.beginSparseArray)
          out.varint(length)
          const count = this.#writeProperties(array, Object.keys(array))
          out.byte(T.endSparseArray)
          out.varint(count)
          out.varint(length)
        }

        #writeString(value: string): void {
          const out = this.#out
          let oneByte = true
          for (let i = 0; i < value.length && oneByte; i++) oneByte = value.charCodeAt(i) <= 0xff
          if (oneByte) {
            out.byte(T.oneByteString)
            out.varint(value.length)
            const bytes = new Uint8Array(value.length)
            for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i)
            return out.raw(bytes)
          }
          const byteLength = value.length * 2
          // Readers expect two-byte characters at an even offset.
          if ((out.length + 1 + varintSize(byteLength)) & 1) out.byte(T.padding)
          out.byte(T.twoByteString)
          out.varint(byteLength)
          const bytes = new Uint8Array(byteLength)
          for (let i = 0; i < value.length; i++) {
            const code = value.charCodeAt(i)
            bytes[i * 2] = code & 0xff
            bytes[i * 2 + 1] = code >> 8
          }
          out.raw(bytes)
        }

        #writeBigIntContents(value: bigint): void {
          const negative = value < 0n
          let magnitude = negative ? -value : value
          const bytes: number[] = []
          while (magnitude) {
            bytes.push(Number(magnitude & 0xffn))
            magnitude >>= 8n
          }
          // Whole 64-bit digits.
          while (bytes.length % 8) bytes.push(0)
          this.#out.varint(bytes.length * 2 + (negative ? 1 : 0))
          this.#out.raw(Uint8Array.from(bytes))
        }

        #writeArrayBuffer(buffer: ArrayBuffer): void {
          const out = this.#out
          if (types.isSharedArrayBuffer(buffer)) {
            const getId = (this as unknown as { _getSharedArrayBufferId?: (buffer: unknown) => number })._getSharedArrayBufferId
            if (typeof getId !== 'function') throw this.#cloneError(`${describe(buffer)} could not be cloned.`)
            out.byte(T.sharedArrayBuffer)
            return out.varint(getId.call(this, buffer) >>> 0)
          }
          const transferId = this.#transfers.get(buffer)
          if (transferId !== undefined) {
            out.byte(T.arrayBufferTransfer)
            return out.varint(transferId)
          }
          if ((buffer as { detached?: boolean }).detached) throw this.#cloneError('An ArrayBuffer is detached and could not be cloned.')
          const resizable = buffer as ArrayBuffer & { resizable?: boolean; maxByteLength?: number }
          if (resizable.resizable) {
            out.byte(T.resizableArrayBuffer)
            out.varint(buffer.byteLength)
            out.varint(resizable.maxByteLength ?? buffer.byteLength)
          } else {
            out.byte(T.arrayBuffer)
            out.varint(buffer.byteLength)
          }
          out.raw(new Uint8Array(buffer))
        }

        #writeView(view: ArrayBufferView): void {
          const out = this.#out
          const name = types.isDataView(view) ? 'DataView' : (typedArrayTag.call(view) as string)
          const subtag = VIEW_TAGS.find(([type]) => type === name)
          if (!subtag) throw this.#cloneError(`${describe(view)} could not be cloned.`)
          out.byte(T.arrayBufferView)
          out.byte(subtag[1])
          out.varint(view.byteOffset)
          out.varint(view.byteLength)
          out.varint((view.buffer as { resizable?: boolean }).resizable ? 2 : 0)
        }

        #writeHostObject(value: object): void {
          this.#out.byte(T.hostObject)
          const write = (this as unknown as { _writeHostObject?: (value: object) => void })._writeHostObject
          if (typeof write !== 'function') throw new Error(`${describe(value)} could not be cloned.`)
          write.call(this, value)
        }

        #writeError(error: Error): void {
          const out = this.#out
          const message = Object.getOwnPropertyDescriptor(error, 'message')
          const cause = Object.getOwnPropertyDescriptor(error, 'cause')
          out.byte(T.error)
          const prototypeTag = ERROR_TAGS[String(error.name)]
          if (prototypeTag) out.varint(prototypeTag)
          if (message && 'value' in message) {
            out.varint(E.message)
            this.#writeString(String(message.value))
          }
          const stack = error.stack
          if (typeof stack === 'string') {
            out.varint(E.stack)
            this.#writeString(stack)
          }
          if (cause && 'value' in cause) {
            out.varint(E.cause)
            this.#write(cause.value)
          }
          out.varint(E.end)
        }
      }

      class Deserializer {
        buffer: ArrayBufferView
        #bytes: Uint8Array
        #position = 0
        #version = 0
        #objects = new Map<number, unknown>()
        #nextId = 0
        #transfers = new Map<number, ArrayBufferLike>()

        constructor(buffer: unknown) {
          if (!ArrayBuffer.isView(buffer)) throw invalidArgType('buffer must be a TypedArray or a DataView')
          this.buffer = buffer
          this.#bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        }

        readHeader(): boolean {
          if (this.#bytes[this.#position] === T.version) {
            this.#position++
            const version = this.#varint()
            if (version === undefined || version > LATEST_VERSION) throw versionError()
            this.#version = version
          }
          if (this.#version < MINIMUM_VERSION) throw versionError()
          return true
        }

        readValue(): unknown {
          return this.#readValue()
        }

        getWireFormatVersion(): number {
          return this.#version
        }

        transferArrayBuffer(id: number, arrayBuffer: unknown): void {
          if (!types.isAnyArrayBuffer(arrayBuffer)) throw invalidArgType('arrayBuffer must be an ArrayBuffer or SharedArrayBuffer')
          this.#transfers.set(id >>> 0, arrayBuffer as ArrayBufferLike)
        }

        readUint32(): number {
          const value = this.#varint()
          if (value === undefined || value > 0xffffffff) throw new Error('ReadUint32() failed')
          return value
        }

        readUint64(): [number, number] {
          const value = this.#bigVarint()
          if (value === undefined) throw new Error('ReadUint64() failed')
          return [Number((value >> 32n) & 0xffffffffn), Number(value & 0xffffffffn)]
        }

        readDouble(): number {
          const value = this.#double()
          if (value === undefined) throw new Error('ReadDouble() failed')
          return value
        }

        _readRawBytes(length: number): number {
          const offset = this.#position
          if (!(length >= 0) || offset + length > this.#bytes.length) throw new Error('ReadRawBytes() failed')
          this.#position += length
          return offset
        }

        // --- reading ---

        #fail(): never {
          throw new Error('Unable to deserialize cloned data.')
        }

        #readValue(): unknown {
          const value = this.#readInternal()
          // A view follows the buffer it uses.
          if (types.isArrayBuffer(value) && this.#peekTag() === T.arrayBufferView) {
            this.#position++
            return this.#readView(value as ArrayBuffer)
          }
          return value
        }

        #peekTag(): number | undefined {
          while (this.#bytes[this.#position] === T.padding) this.#position++
          return this.#position < this.#bytes.length ? this.#bytes[this.#position] : undefined
        }

        #readTag(): number {
          const value = this.#peekTag()
          if (value === undefined) this.#fail()
          this.#position++
          return value
        }

        #varint(): number | undefined {
          let result = 0
          let scale = 1
          for (;;) {
            if (this.#position >= this.#bytes.length) return undefined
            const byte = this.#bytes[this.#position++]
            result += (byte & 0x7f) * scale
            if (!(byte & 0x80)) return result
            scale *= 128
          }
        }

        #bigVarint(): bigint | undefined {
          let result = 0n
          let shift = 0n
          for (;;) {
            if (this.#position >= this.#bytes.length) return undefined
            const byte = this.#bytes[this.#position++]
            result |= BigInt(byte & 0x7f) << shift
            if (!(byte & 0x80)) return result
            shift += 7n
          }
        }

        #needVarint(): number {
          const value = this.#varint()
          return value === undefined ? this.#fail() : value
        }

        #double(): number | undefined {
          if (this.#position + 8 > this.#bytes.length) return undefined
          const value = new DataView(this.#bytes.buffer, this.#bytes.byteOffset + this.#position, 8).getFloat64(0, true)
          this.#position += 8
          return value
        }

        #raw(length: number): Uint8Array {
          if (this.#position + length > this.#bytes.length) this.#fail()
          const bytes = this.#bytes.subarray(this.#position, this.#position + length)
          this.#position += length
          return bytes
        }

        #reserveId(): number {
          return this.#nextId++
        }

        #remember<V>(id: number, value: V): V {
          this.#objects.set(id, value)
          return value
        }

        #readInternal(): unknown {
          const t = this.#readTag()
          switch (t) {
            case T.verifyObjectCount:
              this.#needVarint()
              return this.#readValue()
            case T.undefined:
              return undefined
            case T.null:
              return null
            case T.true:
              return true
            case T.false:
              return false
            case T.int32: {
              const value = this.#needVarint()
              return (value >>> 1) ^ -(value & 1)
            }
            case T.uint32:
              return this.#needVarint()
            case T.double: {
              const value = this.#double()
              return value === undefined ? this.#fail() : value
            }
            case T.bigint:
              return this.#readBigIntContents()
            case T.utf8String:
            case T.oneByteString:
            case T.twoByteString:
              return this.#readStringContents(t)
            case T.objectReference: {
              const id = this.#needVarint()
              if (!this.#objects.has(id)) this.#fail()
              return this.#objects.get(id)
            }
            case T.beginObject: {
              const object = this.#remember(this.#reserveId(), {})
              const count = this.#readProperties(object, T.endObject)
              if (count !== this.#needVarint()) this.#fail()
              return object
            }
            case T.beginSparseArray: {
              const length = this.#needVarint()
              const array = this.#remember(this.#reserveId(), new Array(length))
              const count = this.#readProperties(array, T.endSparseArray)
              if (count !== this.#needVarint() || length !== this.#needVarint()) this.#fail()
              return array
            }
            case T.beginDenseArray: {
              const length = this.#needVarint()
              if (length > this.#bytes.length - this.#position) this.#fail()
              const array = this.#remember(this.#reserveId(), new Array(length))
              for (let i = 0; i < length; i++) {
                if (this.#peekTag() === T.theHole) {
                  this.#position++
                  continue
                }
                define(array, i, this.#readValue())
              }
              const count = this.#readProperties(array, T.endDenseArray)
              if (count !== this.#needVarint() || length !== this.#needVarint()) this.#fail()
              return array
            }
            case T.date: {
              const id = this.#reserveId()
              const time = this.#double()
              return this.#remember(id, new Date(time === undefined ? this.#fail() : time))
            }
            case T.trueObject:
            case T.falseObject:
              return this.#remember(this.#reserveId(), Object(t === T.trueObject))
            case T.numberObject: {
              const id = this.#reserveId()
              const value = this.#double()
              return this.#remember(id, Object(value === undefined ? this.#fail() : value))
            }
            case T.bigintObject: {
              const id = this.#reserveId()
              return this.#remember(id, Object(this.#readBigIntContents()))
            }
            case T.stringObject: {
              const id = this.#reserveId()
              return this.#remember(id, Object(this.#readString()))
            }
            case T.regExp: {
              const id = this.#reserveId()
              const source = this.#readString()
              const bits = this.#needVarint()
              const flags = REGEXP_FLAGS.filter(([, bit]) => bits & bit).map(([flag]) => flag).join('')
              let regExp: RegExp
              try {
                regExp = new RegExp(source, flags)
              } catch {
                this.#fail()
              }
              return this.#remember(id, regExp)
            }
            case T.beginMap: {
              const map = this.#remember(this.#reserveId(), new Map())
              let length = 0
              while (this.#peekTag() !== T.endMap) {
                const key = this.#readValue()
                Map.prototype.set.call(map, key, this.#readValue())
                length += 2
              }
              this.#position++
              if (length !== this.#needVarint()) this.#fail()
              return map
            }
            case T.beginSet: {
              const set = this.#remember(this.#reserveId(), new Set())
              let length = 0
              while (this.#peekTag() !== T.endSet) {
                Set.prototype.add.call(set, this.#readValue())
                length++
              }
              this.#position++
              if (length !== this.#needVarint()) this.#fail()
              return set
            }
            case T.arrayBuffer: {
              const id = this.#reserveId()
              const length = this.#needVarint()
              return this.#remember(id, this.#raw(length).slice().buffer)
            }
            case T.resizableArrayBuffer: {
              const id = this.#reserveId()
              const length = this.#needVarint()
              const maxByteLength = this.#needVarint()
              if (length > maxByteLength) this.#fail()
              const buffer = new (ArrayBuffer as unknown as new (length: number, options: object) => ArrayBuffer)(length, { maxByteLength })
              new Uint8Array(buffer).set(this.#raw(length))
              return this.#remember(id, buffer)
            }
            case T.arrayBufferTransfer:
            case T.sharedArrayBuffer: {
              const id = this.#reserveId()
              const buffer = this.#transfers.get(this.#needVarint())
              if (!buffer) this.#fail()
              return this.#remember(id, buffer)
            }
            case T.hostObject: {
              const id = this.#reserveId()
              const read = (this as unknown as { _readHostObject?: () => unknown })._readHostObject
              if (typeof read !== 'function') this.#fail()
              const object = read.call(this)
              if (typeof object !== 'object' || object === null) throw invalidArgType('readHostObject must return an object')
              return this.#remember(id, object)
            }
            case T.error:
              return this.#readError()
            default:
              return this.#fail()
          }
        }

        #readString(): string {
          const t = this.#readTag()
          if (t !== T.utf8String && t !== T.oneByteString && t !== T.twoByteString) this.#fail()
          return this.#readStringContents(t)
        }

        #readStringContents(t: number): string {
          const length = this.#needVarint()
          const bytes = this.#raw(length)
          if (t === T.utf8String) return new TextDecoder().decode(bytes)
          if (t === T.oneByteString) {
            let text = ''
            for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192))
            return text
          }
          if (length & 1) this.#fail()
          let text = ''
          for (let i = 0; i < length; i += 2) text += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8))
          return text
        }

        #readBigIntContents(): bigint {
          const bitfield = this.#needVarint()
          const bytes = this.#raw(Math.floor(bitfield / 2))
          let value = 0n
          for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i])
          return bitfield & 1 ? -value : value
        }

        #readProperties(object: object, endTag: number): number {
          let count = 0
          while (this.#peekTag() !== endTag) {
            if (this.#peekTag() === undefined) this.#fail()
            const key = this.#readValue()
            if (typeof key !== 'string' && typeof key !== 'number') this.#fail()
            define(object, key, this.#readValue())
            count++
          }
          this.#position++
          return count
        }

        #readView(buffer: ArrayBuffer): ArrayBufferView {
          const subtag = this.#raw(1)[0]
          const byteOffset = this.#needVarint()
          const byteLength = this.#needVarint()
          const flags = this.#version >= 14 ? this.#needVarint() : 0
          const id = this.#reserveId()
          const name = VIEW_TAGS.find(([, value]) => value === subtag)?.[0]
          const View = name && (globalThis as unknown as Record<string, ViewConstructor | undefined>)[name]
          if (!View || byteOffset + byteLength > buffer.byteLength) this.#fail()
          const element = (View as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1
          if (byteOffset % element || byteLength % element) this.#fail()
          // A length-tracking view on a resizable buffer follows the buffer's length.
          const view =
            flags & 1
              ? new (View as unknown as new (buffer: ArrayBufferLike, byteOffset: number) => ArrayBufferView)(buffer, byteOffset)
              : new View(buffer, byteOffset, byteLength / element)
          return this.#remember(id, view)
        }

        #readError(): Error {
          const id = this.#reserveId()
          let constructor: ErrorConstructor = Error
          let message: string | undefined
          let stack: string | undefined
          let options: { cause: unknown } | undefined
          for (;;) {
            const t = this.#needVarint()
            const named = Object.entries(ERROR_TAGS).find(([, value]) => value === t)
            if (named) constructor = (globalThis as unknown as Record<string, ErrorConstructor>)[named[0]]
            else if (t === E.message) message = this.#readString()
            else if (t === E.stack) stack = this.#readString()
            else if (t === E.cause) options = { cause: this.#readValue() }
            else if (t === E.end) break
            else this.#fail()
          }
          const error = options ? new constructor(message, options) : new constructor(message)
          if (stack === undefined) delete (error as { stack?: string }).stack
          else Object.defineProperty(error, 'stack', { value: stack, writable: true, configurable: true, enumerable: false })
          return this.#remember(id, error)
        }
      }

      return { Serializer, Deserializer }
    },
  }
}

function define(object: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true })
}

function versionError(): Error {
  return new Error('Unable to deserialize cloned data due to invalid or unsupported version.')
}
