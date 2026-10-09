// Message digests and HMAC in plain JavaScript, for Node's synchronous crypto.createHash() and
// createHmac(), which WebCrypto's async digest() can't serve. MD5, SHA-1 and the SHA-2 family.
// Round constants are computed from their definitions (roots of primes, sin) instead of being
// transcribed.

export interface Hasher {
  readonly blockSize: number
  readonly outputSize: number
  update(data: Uint8Array): this
  /** Finishes the hash. The hasher can't be used afterwards. */
  digest(): Uint8Array
  clone(): Hasher
}

// --- constants -------------------------------------------------------------------------------

function primes(count: number): number[] {
  const out: number[] = []
  for (let n = 2; out.length < count; n++) if (out.every((p) => n % p !== 0)) out.push(n)
  return out
}

/** floor(root(n) * 2^bits) mod 2^bits, the fractional part of an integer root as a fixed-point number. */
function rootFraction(n: number, degree: 2n | 3n, bits: bigint): bigint {
  const target = BigInt(n) << (bits * degree)
  // Newton's method for the integer root of target.
  let x = 1n << ((BigInt(target.toString(2).length) + degree - 1n) / degree)
  for (;;) {
    const next = ((degree - 1n) * x + target / x ** (degree - 1n)) / degree
    if (next >= x) break
    x = next
  }
  while (x ** degree > target) x--
  return x & ((1n << bits) - 1n)
}

const PRIMES = primes(80)
const MASK32 = 0xffffffffn

/** SHA-512 round constants as [hi, lo] words; SHA-256 uses the high words of the first 64. */
const K512 = PRIMES.map((p) => rootFraction(p, 3n, 64n))
const K512_HI = Uint32Array.from(K512, (k) => Number(k >> 32n))
const K512_LO = Uint32Array.from(K512, (k) => Number(k & MASK32))
const K256 = K512_HI.slice(0, 64)

const SQRT64 = PRIMES.slice(0, 16).map((p) => rootFraction(p, 2n, 64n))
const IV256 = Uint32Array.from(SQRT64.slice(0, 8), (h) => Number(h >> 32n))
// SHA-224's IV is the low half of SHA-384's.
const IV224 = Uint32Array.from(SQRT64.slice(8, 16), (h) => Number(h & MASK32))
const IV512 = SQRT64.slice(0, 8)
const IV384 = SQRT64.slice(8, 16)

const MD5_K = Uint32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32))
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]

// --- shared block buffering ------------------------------------------------------------------

abstract class BlockHash implements Hasher {
  readonly blockSize: number
  readonly outputSize: number
  protected readonly block: Uint8Array
  protected filled = 0
  protected length = 0

  constructor(blockSize: number, outputSize: number) {
    this.blockSize = blockSize
    this.outputSize = outputSize
    this.block = new Uint8Array(blockSize)
  }

  update(data: Uint8Array): this {
    let offset = 0
    this.length += data.length
    if (this.filled) {
      const n = Math.min(this.blockSize - this.filled, data.length)
      this.block.set(data.subarray(0, n), this.filled)
      this.filled += n
      offset = n
      if (this.filled < this.blockSize) return this
      this.compress(this.block, 0)
      this.filled = 0
    }
    for (; offset + this.blockSize <= data.length; offset += this.blockSize) this.compress(data, offset)
    if (offset < data.length) {
      this.block.set(data.subarray(offset), 0)
      this.filled = data.length - offset
    }
    return this
  }

  digest(): Uint8Array {
    const lengthBytes = this.blockSize === 128 ? 16 : 8
    const bits = BigInt(this.length) * 8n
    const padding = new Uint8Array(((this.blockSize - ((this.length + 1 + lengthBytes) % this.blockSize)) % this.blockSize) + 1 + lengthBytes)
    padding[0] = 0x80
    const view = new DataView(padding.buffer)
    if (this.littleEndian) view.setBigUint64(padding.length - 8, bits, true)
    else view.setBigUint64(padding.length - 8, bits, false)
    this.update(padding)
    return this.output()
  }

  abstract clone(): Hasher
  protected abstract readonly littleEndian: boolean
  protected abstract compress(data: Uint8Array, offset: number): void
  protected abstract output(): Uint8Array

  protected copyInto<T extends BlockHash>(target: T): T {
    target.block.set(this.block)
    target.filled = this.filled
    target.length = this.length
    return target
  }
}

function be32(data: Uint8Array, i: number): number {
  return ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0
}

function words(state: Uint32Array, count: number, littleEndian = false): Uint8Array {
  const out = new Uint8Array(count * 4)
  const view = new DataView(out.buffer)
  for (let i = 0; i < count; i++) view.setUint32(i * 4, state[i], littleEndian)
  return out
}

// --- MD5 -------------------------------------------------------------------------------------

class Md5 extends BlockHash {
  protected readonly littleEndian = true
  private readonly state = Uint32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476)
  private readonly x = new Uint32Array(16)

  constructor() {
    super(64, 16)
  }

  clone(): Md5 {
    const copy = this.copyInto(new Md5())
    copy.state.set(this.state)
    return copy
  }

  protected compress(data: Uint8Array, offset: number): void {
    const x = this.x
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4
      x[i] = (data[j] | (data[j + 1] << 8) | (data[j + 2] << 16) | (data[j + 3] << 24)) >>> 0
    }
    let [a, b, c, d] = this.state
    for (let i = 0; i < 64; i++) {
      const round = i >> 4
      let f: number
      let g: number
      if (round === 0) {
        f = (b & c) | (~b & d)
        g = i
      } else if (round === 1) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) & 15
      } else if (round === 2) {
        f = b ^ c ^ d
        g = (3 * i + 5) & 15
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) & 15
      }
      const s = MD5_S[(round << 2) | (i & 3)]
      const sum = (a + f + MD5_K[i] + x[g]) | 0
      a = d
      d = c
      c = b
      b = (b + ((sum << s) | (sum >>> (32 - s)))) | 0
    }
    const state = this.state
    state[0] += a
    state[1] += b
    state[2] += c
    state[3] += d
  }

  protected output(): Uint8Array {
    return words(this.state, 4, true)
  }
}

// --- SHA-1 -----------------------------------------------------------------------------------

class Sha1 extends BlockHash {
  protected readonly littleEndian = false
  private readonly state = Uint32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0)
  private readonly w = new Uint32Array(80)

  constructor() {
    super(64, 20)
  }

  clone(): Sha1 {
    const copy = this.copyInto(new Sha1())
    copy.state.set(this.state)
    return copy
  }

  protected compress(data: Uint8Array, offset: number): void {
    const w = this.w
    for (let i = 0; i < 16; i++) w[i] = be32(data, offset + i * 4)
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]
      w[i] = (x << 1) | (x >>> 31)
    }
    let [a, b, c, d, e] = this.state
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0
      e = d
      d = c
      c = (b << 30) | (b >>> 2)
      b = a
      a = t
    }
    const state = this.state
    state[0] += a
    state[1] += b
    state[2] += c
    state[3] += d
    state[4] += e
  }

  protected output(): Uint8Array {
    return words(this.state, 5)
  }
}

// --- SHA-224 / SHA-256 -----------------------------------------------------------------------

class Sha256 extends BlockHash {
  protected readonly littleEndian = false
  private readonly state: Uint32Array
  private readonly w = new Uint32Array(64)

  constructor(iv: Uint32Array = IV256, outputSize = 32) {
    super(64, outputSize)
    this.state = iv.slice()
  }

  clone(): Sha256 {
    const copy = this.copyInto(new Sha256(this.state, this.outputSize))
    return copy
  }

  protected compress(data: Uint8Array, offset: number): void {
    const w = this.w
    for (let i = 0; i < 16; i++) w[i] = be32(data, offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]
      const y = w[i - 2]
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }
    let [a, b, c, d, e, f, g, h] = this.state
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K256[i] + w[i]) | 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      h = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    const state = this.state
    state[0] += a
    state[1] += b
    state[2] += c
    state[3] += d
    state[4] += e
    state[5] += f
    state[6] += g
    state[7] += h
  }

  protected output(): Uint8Array {
    return words(this.state, this.outputSize / 4)
  }
}

// --- SHA-384 / SHA-512 / SHA-512/t -----------------------------------------------------------

class Sha512 extends BlockHash {
  protected readonly littleEndian = false
  // State words as interleaved [hi, lo] pairs.
  private readonly state: Uint32Array
  private readonly wh = new Uint32Array(80)
  private readonly wl = new Uint32Array(80)

  constructor(iv: readonly bigint[] | Uint32Array = IV512, outputSize = 64) {
    super(128, outputSize)
    this.state = iv instanceof Uint32Array ? iv.slice() : Uint32Array.from(iv.flatMap((h) => [Number(h >> 32n), Number(h & MASK32)]))
  }

  clone(): Sha512 {
    return this.copyInto(new Sha512(this.state, this.outputSize))
  }

  protected compress(data: Uint8Array, offset: number): void {
    const wh = this.wh
    const wl = this.wl
    for (let i = 0; i < 16; i++) {
      wh[i] = be32(data, offset + i * 8)
      wl[i] = be32(data, offset + i * 8 + 4)
    }
    for (let i = 16; i < 80; i++) {
      // σ0 = rotr1 ^ rotr8 ^ shr7, σ1 = rotr19 ^ rotr61 ^ shr6, on 64-bit words split in two.
      const xh = wh[i - 15]
      const xl = wl[i - 15]
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7)
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25))
      const yh = wh[i - 2]
      const yl = wl[i - 2]
      const s1h = ((yh >>> 19) | (yl << 13)) ^ ((yl >>> 29) | (yh << 3)) ^ (yh >>> 6)
      const s1l = ((yl >>> 19) | (yh << 13)) ^ ((yh >>> 29) | (yl << 3)) ^ ((yl >>> 6) | (yh << 26))
      let lo = (s0l >>> 0) + (s1l >>> 0) + wl[i - 7] + wl[i - 16]
      let hi = s0h + s1h + wh[i - 7] + wh[i - 16] + Math.floor(lo / 0x100000000)
      lo >>>= 0
      hi >>>= 0
      wh[i] = hi
      wl[i] = lo
    }
    const st = this.state
    let ah = st[0], al = st[1], bh = st[2], bl = st[3], ch = st[4], cl = st[5], dh = st[6], dl = st[7]
    let eh = st[8], el = st[9], fh = st[10], fl = st[11], gh = st[12], gl = st[13], hh = st[14], hl = st[15]
    for (let i = 0; i < 80; i++) {
      // Σ1(e) = rotr14 ^ rotr18 ^ rotr41
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23))
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23))
      const chh = (eh & fh) ^ (~eh & gh)
      const chl = (el & fl) ^ (~el & gl)
      let t1l = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + K512_LO[i] + wl[i]
      let t1h = hh + S1h + chh + K512_HI[i] + wh[i] + Math.floor(t1l / 0x100000000)
      t1l >>>= 0
      t1h >>>= 0
      // Σ0(a) = rotr28 ^ rotr34 ^ rotr39
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25))
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25))
      const majh = (ah & bh) ^ (ah & ch) ^ (bh & ch)
      const majl = (al & bl) ^ (al & cl) ^ (bl & cl)
      const t2l = (S0l >>> 0) + (majl >>> 0)
      const t2h = S0h + majh + Math.floor(t2l / 0x100000000)
      hh = gh
      hl = gl
      gh = fh
      gl = fl
      fh = eh
      fl = el
      let sum = (dl >>> 0) + t1l
      eh = (dh + t1h + Math.floor(sum / 0x100000000)) >>> 0
      el = sum >>> 0
      dh = ch
      dl = cl
      ch = bh
      cl = bl
      bh = ah
      bl = al
      sum = t1l + (t2l >>> 0)
      ah = (t1h + t2h + Math.floor(sum / 0x100000000)) >>> 0
      al = sum >>> 0
    }
    const add = (i: number, h: number, l: number) => {
      const lo = st[i + 1] + (l >>> 0)
      st[i] = (st[i] + h + Math.floor(lo / 0x100000000)) >>> 0
      st[i + 1] = lo >>> 0
    }
    add(0, ah, al)
    add(2, bh, bl)
    add(4, ch, cl)
    add(6, dh, dl)
    add(8, eh, el)
    add(10, fh, fl)
    add(12, gh, gl)
    add(14, hh, hl)
  }

  protected output(): Uint8Array {
    return words(this.state, 16).subarray(0, this.outputSize)
  }
}

/** The SHA-512/t IV: SHA-512 of "SHA-512/t" from a modified IV (FIPS 180-4 §5.3.6). */
function sha512tIv(t: number): Uint32Array {
  const hasher = new Sha512(IV512.map((h) => h ^ 0xa5a5a5a5a5a5a5a5n))
  const iv = hasher.update(new TextEncoder().encode(`SHA-512/${t}`)).digest()
  const view = new DataView(iv.buffer, iv.byteOffset, iv.byteLength)
  return Uint32Array.from({ length: 16 }, (_, i) => view.getUint32(i * 4))
}

let iv512_224: Uint32Array | undefined
let iv512_256: Uint32Array | undefined

const FACTORIES: Record<string, () => Hasher> = {
  md5: () => new Md5(),
  sha1: () => new Sha1(),
  sha224: () => new Sha256(IV224, 28),
  sha256: () => new Sha256(),
  sha384: () => new Sha512(IV384, 48),
  sha512: () => new Sha512(),
  'sha512-224': () => new Sha512((iv512_224 ??= sha512tIv(224)), 28),
  'sha512-256': () => new Sha512((iv512_256 ??= sha512tIv(256)), 32),
}

// OpenSSL's names and aliases for the same digests.
const ALIASES: Record<string, string> = {
  'rsa-md5': 'md5',
  'ssl3-md5': 'md5',
  md5withrsaencryption: 'md5',
  '1.2.840.113549.2.5': 'md5',
  'rsa-sha1': 'sha1',
  'rsa-sha1-2': 'sha1',
  'ssl3-sha1': 'sha1',
  sha1withrsaencryption: 'sha1',
  dss1: 'sha1',
  '1.3.14.3.2.26': 'sha1',
  'sha-1': 'sha1',
  sha224withrsaencryption: 'sha224',
  '2.16.840.1.101.3.4.2.4': 'sha224',
  sha256withrsaencryption: 'sha256',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  sha384withrsaencryption: 'sha384',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  sha512withrsaencryption: 'sha512',
  '2.16.840.1.101.3.4.2.3': 'sha512',
  'sha512-224withrsaencryption': 'sha512-224',
  'sha512-256withrsaencryption': 'sha512-256',
  'rsa-sha224': 'sha224',
  'sha-224': 'sha224',
  'sha2-224': 'sha224',
  'rsa-sha256': 'sha256',
  'sha-256': 'sha256',
  'sha2-256': 'sha256',
  'rsa-sha384': 'sha384',
  'sha-384': 'sha384',
  'sha2-384': 'sha384',
  'rsa-sha512': 'sha512',
  'sha-512': 'sha512',
  'sha2-512': 'sha512',
  'sha512/224': 'sha512-224',
  'sha-512/224': 'sha512-224',
  'sha2-512/224': 'sha512-224',
  'rsa-sha512/224': 'sha512-224',
  'sha512/256': 'sha512-256',
  'sha-512/256': 'sha512-256',
  'sha2-512/256': 'sha512-256',
  'rsa-sha512/256': 'sha512-256',
}

/** The canonical name of a supported digest (case-insensitive, with OpenSSL aliases). */
export function digestName(name: string): string | undefined {
  const lower = name.toLowerCase()
  const canonical = ALIASES[lower] ?? lower
  return Object.hasOwn(FACTORIES, canonical) ? canonical : undefined
}

/** Digest names as crypto.getHashes() lists them: OpenSSL's spellings of what's implemented. */
export const DIGEST_NAMES = [
  'RSA-MD5', 'RSA-SHA1', 'RSA-SHA1-2', 'RSA-SHA224', 'RSA-SHA256', 'RSA-SHA384', 'RSA-SHA512', 'RSA-SHA512/224',
  'RSA-SHA512/256', 'md5', 'md5WithRSAEncryption', 'sha1', 'sha1WithRSAEncryption', 'sha224', 'sha224WithRSAEncryption',
  'sha256', 'sha256WithRSAEncryption', 'sha384', 'sha384WithRSAEncryption', 'sha512', 'sha512-224',
  'sha512-224WithRSAEncryption', 'sha512-256', 'sha512-256WithRSAEncryption', 'sha512WithRSAEncryption', 'ssl3-md5',
  'ssl3-sha1',
]

export function createHasher(name: string): Hasher | undefined {
  const canonical = digestName(name)
  return canonical ? FACTORIES[canonical]() : undefined
}

/** HMAC (RFC 2104) over any of the digests above. */
export class Hmac {
  private readonly inner: Hasher
  private readonly outer: Hasher

  constructor(name: string, key: Uint8Array) {
    const inner = createHasher(name)
    const outer = createHasher(name)
    if (!inner || !outer) throw new Error(`Invalid digest: ${name}`)
    if (key.length > inner.blockSize) key = createHasher(name)!.update(key).digest()
    const pad = new Uint8Array(inner.blockSize)
    pad.set(key)
    this.inner = inner.update(pad.map((byte) => byte ^ 0x36))
    this.outer = outer.update(pad.map((byte) => byte ^ 0x5c))
  }

  update(data: Uint8Array): this {
    this.inner.update(data)
    return this
  }

  digest(): Uint8Array {
    return this.outer.update(this.inner.digest()).digest()
  }
}

/** PBKDF2 (RFC 8018) with HMAC over `digest`. */
export function pbkdf2(digest: string, password: Uint8Array, salt: Uint8Array, iterations: number, length: number): Uint8Array {
  const out = new Uint8Array(length)
  const block = new Uint8Array(salt.length + 4)
  block.set(salt)
  for (let index = 1, offset = 0; offset < length; index++) {
    new DataView(block.buffer).setUint32(salt.length, index)
    let u = new Hmac(digest, password).update(block).digest()
    const t = u.slice()
    for (let i = 1; i < iterations; i++) {
      u = new Hmac(digest, password).update(u).digest()
      for (let j = 0; j < t.length; j++) t[j] ^= u[j]
    }
    out.set(t.subarray(0, length - offset), offset)
    offset += t.length
  }
  return out
}

/** HKDF (RFC 5869). Throws a RangeError when `length` exceeds 255 hash blocks. */
export function hkdf(digest: string, key: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  const size = createHasher(digest)!.outputSize
  if (length > 255 * size) throw new RangeError('Invalid key length')
  const prk = new Hmac(digest, salt.length ? salt : new Uint8Array(size)).update(key).digest()
  const out = new Uint8Array(length)
  let previous: Uint8Array = new Uint8Array(0)
  for (let offset = 0, counter = 1; offset < length; counter++) {
    previous = new Hmac(digest, prk).update(previous).update(info).update(Uint8Array.of(counter)).digest()
    out.set(previous.subarray(0, length - offset), offset)
    offset += previous.length
  }
  return out
}
