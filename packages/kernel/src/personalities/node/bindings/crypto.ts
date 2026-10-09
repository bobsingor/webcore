// crypto (src/crypto/*) without OpenSSL. Implemented: MD5, SHA-1 and SHA-2 digests, HMAC, PBKDF2,
// HKDF, random bytes, timingSafeEqual, secret keys (KeyObject and CryptoKey), and WebCrypto's
// digest, HMAC, PBKDF2 and HKDF. Ciphers, signatures, asymmetric keys, Diffie-Hellman and TLS
// throw coded errors, and entries that lib/ feature-detects (scrypt, argon2, KMAC, ML-KEM) are
// absent so those features report themselves unsupported.
import { createHasher, digestName, DIGEST_NAMES, hkdf, Hmac as JsHmac, pbkdf2, type Hasher } from '../../../lib/hashes.ts'
import { bytesOf, decode, encode, encodingName, ENCODINGS } from '../codec.ts'
import { host } from '../host.ts'
import type { Realm } from '../realm.ts'

const kCryptoJobAsync = 0
const kCryptoJobSync = 1
const kCryptoJobWebCrypto = 2
const kKeyTypeSecret = 0
const kKeyFormatJWK = 2
const kSignJobModeSign = 0

/** Digest ids, as getCachedAliases() and the `algorithmId` arguments use them. */
const DIGESTS = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha512-224', 'sha512-256']

const CONSTANTS = {
  kCryptoJobAsync,
  kCryptoJobSync,
  kCryptoJobWebCrypto,
  kKeyTypeSecret,
  kKeyTypePublic: 1,
  kKeyTypePrivate: 2,
  kKeyFormatDER: 0,
  kKeyFormatPEM: 1,
  kKeyFormatJWK,
  kKeyFormatRawPublic: 3,
  kKeyFormatRawPrivate: 4,
  kKeyFormatRawSeed: 5,
  kKeyFormatStore: 6,
  kKeyEncodingPKCS1: 0,
  kKeyEncodingPKCS8: 1,
  kKeyEncodingSPKI: 2,
  kKeyEncodingSEC1: 3,
  kSigEncDER: 0,
  kSigEncP1363: 1,
  kSignJobModeSign,
  kSignJobModeVerify: 1,
  kWebCryptoKeyFormatRaw: 0,
  kWebCryptoKeyFormatPKCS8: 1,
  kWebCryptoKeyFormatSPKI: 2,
  kWebCryptoKeyFormatJWK: 3,
  kWebCryptoCipherEncrypt: 0,
  kWebCryptoCipherDecrypt: 1,
  kKeyVariantRSA_SSA_PKCS1_v1_5: 0,
  kKeyVariantRSA_PSS: 1,
  kKeyVariantRSA_OAEP: 2,
  kKeyVariantAES_CTR_128: 0,
  kKeyVariantAES_CTR_192: 1,
  kKeyVariantAES_CTR_256: 2,
  kKeyVariantAES_CBC_128: 3,
  kKeyVariantAES_CBC_192: 4,
  kKeyVariantAES_CBC_256: 5,
  kKeyVariantAES_GCM_128: 6,
  kKeyVariantAES_GCM_192: 7,
  kKeyVariantAES_GCM_256: 8,
  kKeyVariantAES_KW_128: 9,
  kKeyVariantAES_KW_192: 10,
  kKeyVariantAES_KW_256: 11,
  EVP_PKEY_X25519: 1034,
  EVP_PKEY_X448: 1035,
  EVP_PKEY_ED25519: 1087,
  EVP_PKEY_ED448: 1088,
  OPENSSL_EC_NAMED_CURVE: 1,
  OPENSSL_EC_EXPLICIT_CURVE: 0,
  RSA_PKCS1_PSS_PADDING: 6,
  X509_CHECK_FLAG_ALWAYS_CHECK_SUBJECT: 0x1,
  X509_CHECK_FLAG_NO_WILDCARDS: 0x2,
  X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS: 0x4,
  X509_CHECK_FLAG_MULTI_LABEL_WILDCARDS: 0x8,
  X509_CHECK_FLAG_SINGLE_LABEL_SUBDOMAINS: 0x10,
  X509_CHECK_FLAG_NEVER_CHECK_SUBJECT: 0x20,
}

/** An error as Node's C++ THROW_ERR_* macros make them: the type, plus an own `code`. */
function coded<T extends Error>(error: T, code: string): T {
  return Object.assign(error, { code })
}

const invalidDigest = (name: unknown) => coded(new TypeError(`Invalid digest: ${name}`), 'ERR_CRYPTO_INVALID_DIGEST')
const unavailable = (feature: string) =>
  coded(new TypeError(`The feature ${feature} is unavailable on the current platform, which is being used to run Node.js`), 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM')

function isBufferSource(value: unknown): value is ArrayBufferLike | ArrayBufferView {
  return value instanceof ArrayBuffer || value instanceof SharedArrayBuffer || ArrayBuffer.isView(value)
}

function sourceBytes(value: ArrayBufferLike | ArrayBufferView): Uint8Array {
  return ArrayBuffer.isView(value) ? bytesOf(value) : new Uint8Array(value)
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return host.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export function cryptoBindings() {
  return {
    crypto: (realm: Realm) => {
      const { loop } = realm
      const buffer = (bytes: Uint8Array) => realm.newBuffer(bytes)

      /** Digest output: a Buffer unless a known string encoding is asked for (ParseEncoding). */
      const output = (bytes: Uint8Array, encoding: unknown) => {
        const name = typeof encoding === 'string' ? encodingName(encoding) : 'buffer'
        return name !== 'buffer' && ENCODINGS.includes(name) ? decode(bytes, name) : buffer(bytes.slice())
      }

      const input = (data: string | ArrayBufferView, encoding: unknown) => {
        if (typeof data !== 'string') return bytesOf(data)
        const name = typeof encoding === 'string' ? encodingName(encoding) : 'utf8'
        return encode(data, name !== 'buffer' && ENCODINGS.includes(name) ? name : 'utf8')
      }

      const resolveDigest = (name: unknown, id: number | undefined, cache?: Record<string, number>) => {
        if (typeof id === 'number' && id >= 0) return DIGESTS[id]
        const canonical = typeof name === 'string' ? digestName(name) : undefined
        if (canonical && cache && typeof name === 'string') cache[name] = DIGESTS.indexOf(canonical)
        return canonical
      }

      const requireDigest = (name: unknown) => {
        const canonical = typeof name === 'string' ? digestName(name) : undefined
        if (!canonical) throw invalidDigest(name)
        return canonical
      }

      const randomFill = (bytes: Uint8Array) => {
        // getRandomValues refuses shared memory and more than 64 KiB at a time.
        const target = bytes.buffer instanceof SharedArrayBuffer ? new Uint8Array(bytes.length) : bytes
        for (let i = 0; i < target.length; i += 65536) host.getRandomValues(target.subarray(i, i + 65536) as Uint8Array<ArrayBuffer>)
        if (target !== bytes) bytes.set(target)
      }

      // --- keys ----------------------------------------------------------------------------

      interface KeyData {
        type: number
        bytes: Uint8Array
      }

      const handleData = new WeakMap<object, KeyData>()

      class KeyObjectHandle {
        init(type: number, data: unknown, format?: number) {
          if (type !== kKeyTypeSecret) throw unavailable('Asymmetric keys')
          let bytes: Uint8Array
          if (arguments.length === 5 && format === kKeyFormatJWK) {
            const k = (data as { k?: unknown })?.k
            if (typeof k !== 'string') throw coded(new TypeError('Invalid JWK secret key format'), 'ERR_CRYPTO_INVALID_JWK')
            const binary = host.atob(k.replace(/-/g, '+').replace(/_/g, '/'))
            bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
          } else {
            bytes = sourceBytes(data as ArrayBufferView).slice()
          }
          handleData.set(this, { type: kKeyTypeSecret, bytes })
        }

        getSymmetricKeySize() {
          return this.data.bytes.length
        }

        getKeyType() {
          return this.data.type
        }

        /** A Buffer over its own exactly sized ArrayBuffer: subtle.exportKey('raw') hands out `.buffer`. */
        export() {
          return buffer(this.data.bytes.slice())
        }

        exportJwk(target: Record<string, unknown>) {
          target.kty = 'oct'
          target.k = base64url(this.data.bytes)
          return target
        }

        equals(other: KeyObjectHandle) {
          return constantTimeEqual(this.data.bytes, keyBytes(other))
        }

        keyDetail(target: Record<string, unknown>) {
          target.length = this.data.bytes.length * 8
          return target
        }

        getAsymmetricKeyType() {
          return undefined
        }

        private get data(): KeyData {
          const data = handleData.get(this)
          if (!data) throw coded(new TypeError('Illegal invocation'), 'ERR_INVALID_THIS')
          return data
        }
      }

      const wrap = (data: KeyData) => {
        const handle = new KeyObjectHandle()
        handleData.set(handle, data)
        return handle
      }

      /** Key material from a KeyObjectHandle or a buffer source (ByteSource::FromSecretKeyBytes). */
      const keyBytes = (key: unknown): Uint8Array => {
        const data = typeof key === 'object' && key !== null ? handleData.get(key) : undefined
        if (data) return data.bytes
        if (typeof key === 'string') return encode(key, 'utf8')
        if (isBufferSource(key)) return sourceBytes(key)
        throw coded(new TypeError('Invalid key'), 'ERR_INVALID_ARG_TYPE')
      }

      const keyObjects = new WeakMap<object, KeyData>()
      const cryptoKeys = new WeakMap<object, { data: KeyData; algorithm: unknown; usages: number; extractable: boolean }>()
      let InternalCryptoKey: new (handle: KeyObjectHandle, algorithm: unknown, usages: number, extractable: boolean) => object

      // --- hashing -------------------------------------------------------------------------

      class Hash {
        #hasher: Hasher
        #digest?: Uint8Array

        constructor(algorithm: string | Hash, xofLen?: number, algorithmId?: number, cache?: Record<string, number>) {
          if (algorithm instanceof Hash) {
            this.#hasher = algorithm.#hasher.clone()
            return
          }
          const name = resolveDigest(algorithm, algorithmId, cache)
          const hasher = name ? createHasher(name) : undefined
          if (!hasher) throw new Error('Digest method not supported')
          if (xofLen !== undefined && xofLen !== hasher.outputSize) {
            throw Object.assign(new Error('error:030000B2:digital envelope routines::not XOF or invalid length'), {
              library: 'digital envelope routines',
              reason: 'not XOF or invalid length',
              code: 'ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH',
            })
          }
          this.#hasher = hasher
        }

        update(data: string | ArrayBufferView, encoding?: unknown) {
          this.#hasher.update(input(data, encoding))
          return true
        }

        /** The digest is computed once: _flush and digest() may both ask for it. */
        digest(encoding?: unknown) {
          this.#digest ??= this.#hasher.digest()
          return output(this.#digest, encoding)
        }
      }

      class Hmac {
        #hmac?: JsHmac
        #done = false

        init(name: string, key: unknown) {
          this.#hmac = new JsHmac(requireDigest(name), keyBytes(key))
        }

        update(data: string | ArrayBufferView, encoding?: unknown) {
          this.#hmac?.update(input(data, encoding))
          return true
        }

        digest(encoding?: unknown) {
          if (this.#done || !this.#hmac) return output(new Uint8Array(0), encoding)
          this.#done = true
          return output(this.#hmac.digest(), encoding)
        }
      }

      // --- jobs ----------------------------------------------------------------------------

      /**
       * CryptoJob: arguments are validated by the constructor; run() computes synchronously
       * ([err, result]), on a later macrotask (ondone), or as a WebCrypto Promise.
       */
      const job = (work: (...args: never[]) => () => unknown) =>
        class CryptoJob {
          ondone?: (error?: unknown, result?: unknown) => void
          readonly #mode: number
          readonly #work: () => unknown

          constructor(mode: number, ...args: never[]) {
            this.#mode = mode
            this.#work = work(...args)
          }

          run() {
            if (this.#mode === kCryptoJobSync) {
              try {
                return [undefined, this.#work()]
              } catch (error) {
                return [error, undefined]
              }
            }
            if (this.#mode === kCryptoJobAsync) {
              loop.requestStarted()
              loop.defer(() => {
                loop.requestFinished()
                let result: unknown
                try {
                  result = this.#work()
                } catch (error) {
                  loop.callback(() => this.ondone?.call(this, error))
                  return
                }
                loop.callback(() => this.ondone?.call(this, undefined, result))
              })
              return undefined
            }
            const DOMException = realm.perContextExports.DOMException as new (message: string, options: object) => Error
            return loop.track(
              new Promise((resolve, reject) =>
                loop.defer(() => {
                  try {
                    const result = this.#work()
                    resolve(ArrayBuffer.isView(result) ? result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) : result)
                  } catch (cause) {
                    reject(new DOMException('The operation failed for an operation-specific reason', { name: 'OperationError', cause }))
                  }
                }),
              ),
            )
          }
        }

      const arrayBuffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      const throwing = (feature: string) =>
        class {
          constructor() {
            throw unavailable(feature)
          }
        }
      const unsupported = (feature: string) => () => {
        throw unavailable(feature)
      }

      return {
        ...CONSTANTS,

        Hash,
        Hmac,
        KeyObjectHandle,

        getCachedAliases: () => Object.create(null) as Record<string, number>,
        getHashes: () => [...DIGEST_NAMES],
        getCiphers: () => [],
        getCurves: () => [],
        getSSLCiphers: () => [],
        getCipherInfo: () => undefined,

        oneShotDigest: (
          algorithm: string,
          algorithmId: number,
          cache: Record<string, number>,
          data: string | ArrayBufferView,
          encoding: string,
          encodingId: number | undefined,
          outputLength: number | undefined,
        ) => {
          const name = resolveDigest(algorithm, algorithmId, cache)
          const hasher = name ? createHasher(name) : undefined
          if (!hasher) throw new Error(`Digest method ${algorithm} is not supported`)
          if (outputLength !== undefined && outputLength !== hasher.outputSize) {
            throw new Error(`Output length ${outputLength} is invalid for ${algorithm}, which does not support XOF`)
          }
          const digest = hasher.update(typeof data === 'string' ? encode(data, 'utf8') : bytesOf(data)).digest()
          const target = typeof encodingId === 'number' ? ENCODINGS[encodingId] : encodingName(encoding)
          return target === 'buffer' || !ENCODINGS.includes(target) ? buffer(digest) : decode(digest, target)
        },

        timingSafeEqual: (a: unknown, b: unknown) => {
          for (const [value, name] of [
            [a, 'buf1'],
            [b, 'buf2'],
          ] as const) {
            if (!isBufferSource(value)) {
              throw coded(new TypeError(`The "${name}" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.`), 'ERR_INVALID_ARG_TYPE')
            }
          }
          const x = sourceBytes(a as ArrayBufferView)
          const y = sourceBytes(b as ArrayBufferView)
          if (x.length !== y.length) {
            throw coded(new RangeError('Input buffers must have the same byte length'), 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH')
          }
          return constantTimeEqual(x, y)
        },

        secureBuffer: (size: number) => new Uint8Array(size),
        secureHeapUsed: () => 0n,
        getFipsCrypto: () => 0,
        testFipsCrypto: () => 0,
        setFipsCrypto: (enabled: unknown) => {
          if (enabled) throw new Error('FIPS mode is not supported')
        },
        getOpenSSLSecLevelCrypto: () => 2,

        // Keys: KeyObject and CryptoKey keep their material in native slots (Node 24).
        createNativeKeyObjectClass: (callback: (base: unknown) => unknown[]) => {
          class NativeKeyObject {
            constructor(handle: KeyObjectHandle) {
              const data = handleData.get(handle)
              if (!data) throw coded(new TypeError('Invalid key handle'), 'ERR_INVALID_ARG_TYPE')
              keyObjects.set(this, data)
            }
          }
          return callback(NativeKeyObject)
        },
        getKeyObjectSlots: (key: object) => {
          const data = typeof key === 'object' && key !== null ? keyObjects.get(key) : undefined
          if (!data) throw coded(new TypeError('Value of "this" must be of type KeyObject'), 'ERR_INVALID_THIS')
          return [data.type, wrap(data)]
        },
        createCryptoKeyClass: (callback: (base: unknown) => unknown[]) => {
          class NativeCryptoKey {
            constructor(handle: KeyObjectHandle, algorithm: unknown, usages: number, extractable: boolean) {
              const data = handleData.get(handle)
              if (!data) throw coded(new TypeError('Invalid key handle'), 'ERR_INVALID_ARG_TYPE')
              cryptoKeys.set(this, { data, algorithm, usages, extractable })
            }
          }
          const classes = callback(NativeCryptoKey)
          InternalCryptoKey = classes[1] as typeof InternalCryptoKey
          return classes
        },
        getCryptoKeySlots: (key: object) => {
          const slots = typeof key === 'object' && key !== null ? cryptoKeys.get(key) : undefined
          if (!slots) throw coded(new TypeError('Value of "this" must be of type CryptoKey'), 'ERR_INVALID_THIS')
          return [slots.data.type, slots.extractable, slots.algorithm, slots.usages, wrap(slots.data)]
        },

        // Jobs.
        RandomBytesJob: job((target: ArrayBufferLike | ArrayBufferView, offset: number, size: number) => () => {
          const view = ArrayBuffer.isView(target) ? new Uint8Array(target.buffer, target.byteOffset + offset, size) : new Uint8Array(target, offset, size)
          randomFill(view)
          return undefined
        }),
        PBKDF2Job: job((password: unknown, salt: ArrayBufferView, iterations: number, length: number, digest: string) => {
          const name = requireDigest(digest)
          const key = keyBytes(password)
          const saltBytes = sourceBytes(salt)
          return () => arrayBuffer(pbkdf2(name, key, saltBytes, iterations, length))
        }),
        HKDFJob: job((digest: string, key: unknown, salt: ArrayBufferView, info: ArrayBufferView, length: number) => {
          const name = requireDigest(digest)
          if (length > 255 * createHasher(name)!.outputSize) throw coded(new RangeError('Invalid key length'), 'ERR_CRYPTO_INVALID_KEYLEN')
          const material = keyBytes(key)
          return () => arrayBuffer(hkdf(name, material, sourceBytes(salt), sourceBytes(info), length))
        }),
        HashJob: job((algorithm: string, data: ArrayBufferView, lengthBits?: number) => {
          const name = requireDigest(algorithm)
          const bytes = sourceBytes(data).slice()
          if (lengthBits !== undefined && lengthBits !== createHasher(name)!.outputSize * 8) {
            throw coded(new TypeError('Digest method not supported'), 'ERR_CRYPTO_INVALID_DIGEST')
          }
          return () => arrayBuffer(createHasher(name)!.update(bytes).digest())
        }),
        HmacJob: job((mode: number, digest: string, key: unknown, data: ArrayBufferView, signature?: ArrayBufferView) => {
          const name = requireDigest(digest)
          const material = keyBytes(key)
          const bytes = sourceBytes(data).slice()
          return () => {
            const mac = new JsHmac(name, material).update(bytes).digest()
            if (mode === kSignJobModeSign) return arrayBuffer(mac)
            const expected = signature ? sourceBytes(signature) : new Uint8Array(0)
            return mac.length > 0 && constantTimeEqual(mac, expected)
          }
        }),
        SecretKeyGenJob: job((lengthBits: number, algorithm?: unknown, usages?: number, extractable?: boolean) => () => {
          const webCrypto = algorithm !== undefined
          const bytes = new Uint8Array(webCrypto ? Math.ceil(lengthBits / 8) : Math.floor(lengthBits / 8))
          randomFill(bytes)
          if (webCrypto && lengthBits % 8) bytes[bytes.length - 1] &= 0xff << (8 - (lengthBits % 8))
          const handle = wrap({ type: kKeyTypeSecret, bytes })
          return webCrypto ? new InternalCryptoKey(handle, algorithm, usages ?? 0, extractable ?? false) : handle
        }),

        // Not available without OpenSSL: coded errors where Node's own JavaScript doesn't already
        // report the feature as unsupported.
        CipherBase: class CipherBase {
          constructor() {
            throw coded(new Error('Unknown cipher'), 'ERR_CRYPTO_UNKNOWN_CIPHER')
          }
        },
        Sign: class Sign {
          init() {
            throw unavailable('crypto.createSign')
          }
        },
        Verify: class Verify {
          init() {
            throw unavailable('crypto.createVerify')
          }
        },
        DiffieHellman: throwing('crypto.createDiffieHellman'),
        DiffieHellmanGroup: class DiffieHellmanGroup {
          constructor() {
            throw coded(new Error('Unknown DH group'), 'ERR_CRYPTO_UNKNOWN_DH_GROUP')
          }
        },
        ECDH: class ECDH {
          constructor() {
            throw coded(new TypeError('Invalid EC curve name'), 'ERR_CRYPTO_INVALID_CURVE')
          }
        },
        ECDHConvertKey: unsupported('crypto.ECDH.convertKey'),
        publicEncrypt: unsupported('crypto.publicEncrypt'),
        privateDecrypt: unsupported('crypto.privateDecrypt'),
        privateEncrypt: unsupported('crypto.privateEncrypt'),
        publicDecrypt: unsupported('crypto.publicDecrypt'),
        RsaKeyPairGenJob: throwing('RSA key generation'),
        DsaKeyPairGenJob: throwing('DSA key generation'),
        EcKeyPairGenJob: throwing('EC key generation'),
        NidKeyPairGenJob: throwing('Ed25519/X25519 key generation'),
        DhKeyPairGenJob: throwing('Diffie-Hellman key generation'),
        RandomPrimeJob: throwing('crypto.generatePrime'),
        CheckPrimeJob: throwing('crypto.checkPrime'),
        KEMEncapsulateJob: throwing('KEM'),
        KEMDecapsulateJob: throwing('KEM'),
        parseX509: unsupported('X509Certificate'),
        certVerifySpkac: unsupported('crypto.Certificate'),
        certExportPublicKey: unsupported('crypto.Certificate'),
        certExportChallenge: unsupported('crypto.Certificate'),
        SecureContext: throwing('TLS'),

        // TLS certificate stores, touched when tls loads.
        startLoadingCertificatesOffThread: () => {},
        getBundledRootCertificates: () => [],
        getExtraCACertificates: () => [],
        getSystemCACertificates: () => [],
        getUserRootCertificates: () => [],
        resetRootCertStore: () => {},
        getCertificateCompressionAlgorithms: () => [],
      }
    },

    // tls loads with the crypto binding; TLS itself needs OpenSSL (SecureContext throws).
    tls_wrap: () => {
      class TLSWrap {}
      return {
        TLSWrap,
        HAVE_SSL_TRACE: 0,
        wrap: () => {
          throw unavailable('TLS')
        },
      }
    },
  }
}
