// Unpacking package archives straight into the filesystem (ADR-0015). One call verifies, gunzips
// (natively, with DecompressionStream) and writes a whole npm tarball, where a process doing the
// same would spend three syscalls per file.
import { kerr } from '../abi/errno.ts'
import { gunzip, isGzip, parseTar } from '../lib/tar.ts'
import { dirname, resolve } from './path.ts'
import type { MemFS } from './vfs.ts'

export interface ExtractOptions {
  /** Leading path components to drop (1 for npm's `package/`). */
  strip?: number
  /** A Subresource Integrity string ("sha512-…"); the archive is rejected if it doesn't match. */
  integrity?: string
}

// Strongest first; WebCrypto has all four.
const SRI_ALGORITHMS: [prefix: string, name: string][] = [
  ['sha512', 'SHA-512'],
  ['sha384', 'SHA-384'],
  ['sha256', 'SHA-256'],
  ['sha1', 'SHA-1'],
]

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Checks `data` against the strongest hash in an SRI string. Unknown algorithms pass. */
export async function checkIntegrity(data: Uint8Array, integrity: string): Promise<boolean> {
  const hashes = integrity.trim().split(/\s+/).map((entry) => {
    const dash = entry.indexOf('-')
    return { algorithm: entry.slice(0, dash), digest: entry.slice(dash + 1).split('?')[0] }
  })
  for (const [prefix, name] of SRI_ALGORITHMS) {
    const expected = hashes.filter((hash) => hash.algorithm === prefix).map((hash) => hash.digest)
    if (!expected.length) continue
    const actual = base64(new Uint8Array(await crypto.subtle.digest(name, data as Uint8Array<ArrayBuffer>)))
    return expected.includes(actual)
  }
  return true
}

/** Unpacks a (gzipped) tar archive into `dir`. Returns the number of files written. */
export async function extractArchive(fs: MemFS, archive: Uint8Array, dir: string, options: ExtractOptions = {}): Promise<number> {
  if (options.integrity && !(await checkIntegrity(archive, options.integrity))) throw kerr('EBADMSG', 'integrity check failed')
  const tar = isGzip(archive) ? await gunzip(archive) : archive
  const strip = options.strip ?? 0
  fs.mkdirp(dir)
  let files = 0
  for (const entry of parseTar(tar)) {
    const parts = entry.path.split('/').filter((part) => part && part !== '.').slice(strip)
    // Archives must not write outside their directory.
    if (!parts.length || parts.includes('..')) continue
    const target = resolve(dir, parts.join('/'))
    if (entry.type === 'directory') {
      fs.mkdirp(target)
      continue
    }
    fs.mkdirp(dirname(target))
    fs.writeFile(target, entry.data, entry.mode & 0o111 ? 0o755 : 0o644)
    files++
  }
  return files
}
