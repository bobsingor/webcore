// A fake npm registry for tests: abbreviated packuments and real gzipped tarballs, served over
// HTTP from the test process. Packages are declared as package.json fields plus files.
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { gzipSync } from 'node:zlib'

export interface FakePackage {
  name: string
  version: string
  /** Other package.json fields (dependencies, bin, …). */
  manifest?: Record<string, unknown>
  /** Files besides package.json, relative to the package root. */
  files?: Record<string, string>
  /** Registry-only metadata, e.g. { deprecated: '…' } or { hasInstallScript: true }. */
  meta?: Record<string, unknown>
  /** Serve a tarball that doesn't match the published integrity. */
  corrupt?: boolean
}

function tarHeader(name: string, size: number, mode: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  header.write('        ', 148)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return header
}

export function tarball(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = []
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    blocks.push(tarHeader(`package/${path}`, data.length, path.startsWith('bin/') ? 0o755 : 0o644), data)
    blocks.push(Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

export class FakeRegistry {
  /** Paths requested, in order. */
  readonly requests: string[] = []
  private readonly tarballs = new Map<string, Buffer>()
  private readonly packuments = new Map<string, { name: string; 'dist-tags': Record<string, string>; versions: Record<string, Record<string, unknown>> }>()
  private readonly server: Server
  private port = 0

  constructor(packages: FakePackage[]) {
    for (const pkg of packages) {
      const manifest = { name: pkg.name, version: pkg.version, ...pkg.manifest }
      const data = tarball({ 'package.json': JSON.stringify(manifest, null, 2), ...pkg.files })
      const file = `/${pkg.name}/-/${pkg.name.split('/').pop()}-${pkg.version}.tgz`
      this.tarballs.set(file, pkg.corrupt ? tarball({ 'package.json': '{}' }) : data)
      const packument = this.packuments.get(pkg.name) ?? { name: pkg.name, 'dist-tags': {}, versions: {} }
      packument.versions[pkg.version] = {
        ...manifest,
        ...pkg.meta,
        dist: { tarball: file, integrity: `sha512-${createHash('sha512').update(data).digest('base64')}` },
      }
      const latest = packument['dist-tags'].latest
      if (!pkg.version.includes('-') && (!latest || latest.localeCompare(pkg.version, undefined, { numeric: true }) < 0)) {
        packument['dist-tags'].latest = pkg.version
      }
      this.packuments.set(pkg.name, packument)
    }
    this.server = createServer((req, res) => {
      const path = decodeURIComponent(req.url ?? '/')
      this.requests.push(path)
      const data = this.tarballs.get(path)
      if (data) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        return res.end(data)
      }
      const packument = this.packuments.get(path.slice(1))
      if (!packument) {
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end('{"error":"Not found"}')
      }
      // Tarball URLs are absolute, on whatever host the client used.
      const versions = Object.fromEntries(
        Object.entries(packument.versions).map(([version, entry]) => {
          const dist = entry.dist as { tarball: string; integrity: string }
          return [version, { ...entry, dist: { ...dist, tarball: `http://${req.headers.host}${dist.tarball}` } }]
        }),
      )
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ...packument, versions }))
    })
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/`
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.port = (this.server.address() as { port: number }).port
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()))
  }
}
