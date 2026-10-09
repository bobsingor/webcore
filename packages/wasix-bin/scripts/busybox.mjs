// Builds BusyBox for WASIX: pinned source, verified by its checksum, patched (busybox/patches),
// configured from busybox/config over `allnoconfig`, and cross-compiled with wasixcc through
// BusyBox's own build. Headers and functions the sysroot lacks come from libwebcore.
import { execFileSync, execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'

export const BUSYBOX = {
  version: '1.38.0',
  sha256: '34f9ea6ff8636f2c9241153b9114eefa9e65674a45318ae1ef95bb5f31c53bb2',
}

const root = new URL('..', import.meta.url).pathname
const cache = join(root, 'node_modules/.cache/busybox')

async function download() {
  const file = join(cache, `busybox-${BUSYBOX.version}.tar.bz2`)
  if (existsSync(file)) return file
  mkdirSync(cache, { recursive: true })
  const url = `https://busybox.net/downloads/busybox-${BUSYBOX.version}.tar.bz2`
  console.log(`Downloading ${url}…`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  const tarball = new Uint8Array(await response.arrayBuffer())
  const sha256 = createHash('sha256').update(tarball).digest('hex')
  if (sha256 !== BUSYBOX.sha256) throw new Error(`busybox-${BUSYBOX.version}.tar.bz2: sha256 ${sha256}, expected ${BUSYBOX.sha256}`)
  writeFileSync(file, tarball)
  return file
}

/** The patched source tree, extracted afresh whenever the patches change. */
async function source() {
  const dir = join(cache, `busybox-${BUSYBOX.version}`)
  const patchDir = join(root, 'busybox/patches')
  const patches = readdirSync(patchDir).filter((name) => name.endsWith('.patch')).sort()
  const stamp = join(dir, '.webcore-patches')
  const applied = patches.map((name) => readFileSync(join(patchDir, name), 'utf8')).join('\n')
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === applied) return dir
  const tarball = await download()
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  execFileSync('tar', ['-xjf', tarball, '-C', dir, '--strip-components=1'])
  for (const name of patches) execFileSync('patch', ['-p1', '-s', '-i', join(patchDir, name)], { cwd: dir, stdio: 'inherit' })
  writeFileSync(stamp, applied)
  return dir
}

/** `allnoconfig`, then our options, then `oldconfig` to settle dependencies. */
function configure(dir, libwebcore) {
  const fragment = readFileSync(join(root, 'busybox/config'), 'utf8')
  const extra = {
    CONFIG_EXTRA_CFLAGS: `-I${libwebcore.include} -include webcore/compat.h`,
    CONFIG_EXTRA_LDFLAGS: libwebcore.ldflags.join(' '),
    CONFIG_EXTRA_LDLIBS: libwebcore.libs.join(' '),
  }
  const wanted = JSON.stringify({ fragment, extra })
  const stamp = join(dir, '.webcore-config')
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === wanted) return
  rmSync(stamp, { force: true })
  execFileSync('make', ['allnoconfig'], { cwd: dir, stdio: 'ignore' })
  let config = readFileSync(join(dir, '.config'), 'utf8')
  const options = [...fragment.split('\n'), ...Object.entries(extra).map(([name, value]) => `${name}="${value}"`)]
  const set = []
  for (const line of options) {
    const match = /^(CONFIG_[A-Z0-9_]+)=(.*)$/.exec(line)
    if (!match) continue
    const pattern = new RegExp(`^(# ${match[1]} is not set|${match[1]}=.*)$`, 'm')
    if (!pattern.test(config)) throw new Error(`busybox/config: unknown option ${match[1]}`)
    config = config.replace(pattern, () => line)
    set.push(line)
  }
  writeFileSync(join(dir, '.config'), config)
  execSync('yes "" | make oldconfig', { cwd: dir, stdio: 'ignore' })
  const settled = readFileSync(join(dir, '.config'), 'utf8').split('\n')
  const dropped = set.filter((line) => !settled.includes(line))
  if (dropped.length) throw new Error(`busybox/config: dropped by dependencies: ${dropped.join(', ')}`)
  writeFileSync(stamp, wanted)
}

/**
 * Builds dist/busybox.wasm, and dist/busybox.links: where each applet goes (/bin/ls, /usr/bin/awk…).
 * `env` runs the toolchain, `libwebcore` links libwebcore.
 */
export async function buildBusybox(env, libwebcore) {
  const dir = await source()
  configure(dir, libwebcore)
  const make = ['-j', String(availableParallelism()), 'CC=wasixcc', 'AR=wasixar', 'HOSTCC=cc', 'SKIP_STRIP=y', 'busybox', 'busybox.links']
  if (process.env.KEEP_GOING) make.unshift('-k')
  execFileSync('make', make, { cwd: dir, env, stdio: 'inherit' })
  mkdirSync(join(root, 'dist'), { recursive: true })
  copyFileSync(join(dir, 'busybox'), join(root, 'dist/busybox.wasm'))
  copyFileSync(join(dir, 'busybox.links'), join(root, 'dist/busybox.links'))
}
