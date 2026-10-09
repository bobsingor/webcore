// The JavaScript digests (src/lib/hashes.ts), checked against the test runner's own node:crypto.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createHasher, Hmac, pbkdf2 } from '../src/lib/hashes.ts'

const ALGORITHMS = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha512-224', 'sha512-256']
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

describe('hashes', () => {
  it('match OpenSSL for every length around block boundaries, fed whole and in pieces', () => {
    for (const algorithm of ALGORITHMS) {
      for (const length of [0, 1, 55, 56, 63, 64, 65, 111, 112, 127, 128, 129, 1000, 4099]) {
        const data = randomBytes(length)
        const expected = createHash(algorithm).update(data).digest('hex')
        expect(hex(createHasher(algorithm)!.update(data).digest()), `${algorithm} ${length}`).toBe(expected)
        const pieces = createHasher(algorithm)!
        for (let i = 0; i < length; i += 7) pieces.update(data.subarray(i, i + 7))
        expect(hex(pieces.digest()), `${algorithm} ${length} in pieces`).toBe(expected)
      }
    }
  })

  it('clones mid-stream, and resolves OpenSSL aliases', () => {
    const hasher = createHasher('SHA-256')!.update(Buffer.from('hello '))
    const copy = hasher.clone()
    expect(hex(hasher.update(Buffer.from('world')).digest())).toBe(createHash('sha256').update('hello world').digest('hex'))
    expect(hex(copy.update(Buffer.from('there')).digest())).toBe(createHash('sha256').update('hello there').digest('hex'))
    expect(createHasher('RSA-SHA1')).toBeDefined()
    expect(createHasher('whirlpool')).toBeUndefined()
  })

  it('computes HMAC and PBKDF2', () => {
    for (const algorithm of ALGORITHMS) {
      for (const key of [randomBytes(5), randomBytes(200)]) {
        const data = randomBytes(300)
        expect(hex(new Hmac(algorithm, key).update(data).digest())).toBe(createHmac(algorithm, key).update(data).digest('hex'))
      }
    }
    expect(hex(pbkdf2('sha256', Buffer.from('password'), Buffer.from('salt'), 1000, 50))).toBe(
      pbkdf2Sync('password', 'salt', 1000, 50, 'sha256').toString('hex'),
    )
  })
})
