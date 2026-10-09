// Builds the WASIX programs with the pinned toolchain (scripts/toolchain.mjs): libwebcore, the test
// programs in src/, and BusyBox (scripts/busybox.mjs). Every program links libwebcore. Nothing is
// rebuilt while the inputs stay the same.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUSYBOX, buildBusybox } from './busybox.mjs'
import { toolchain, VERSIONS } from './toolchain.mjs'

const root = new URL('..', import.meta.url).pathname
const dist = join(root, 'dist')
const build = join(root, 'node_modules/.cache/libwebcore')
/** libc functions libwebcore replaces (--wrap): each calls the kernel instead. */
const WRAPPED = [
  'sigaction', '__sigaction', 'sigsuspend', 'pause', 'kill', 'waitpid', 'execv',
  '__vfork_internal', '__vfork_restore',
  'setpgid', 'getpgid', 'getpgrp', 'setsid', 'getsid',
  'tcgetattr', 'tcsetattr', 'tcgetpgrp', 'tcsetpgrp',
  'fstat', '__wasilibc_nocwd_fstatat', 'chmod', 'fchmod', 'fchmodat', 'umask',
  'utimensat', 'futimens', 'utimes', 'utime',
  'getuid', 'geteuid', 'getgid', 'getegid', 'uname',
]

/** A hash of everything the output depends on. */
function inputsHash() {
  const hash = createHash('sha256').update(JSON.stringify({ VERSIONS, BUSYBOX, WRAPPED }))
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else hash.update(`${path.slice(root.length)}\n`).update(readFileSync(path))
    }
  }
  for (const dir of ['scripts', 'src', 'libwebcore', 'busybox']) walk(join(root, dir))
  return hash.digest('hex')
}

/**
 * libwebcore (libwebcore/): Linux calls that wasix-libc answers from the program's memory, routed
 * to the kernel through the `webcore` import module, and POSIX functions the sysroot lacks.
 * Returns the flags that link it.
 */
function buildLibwebcore(env) {
  mkdirSync(build, { recursive: true })
  const sources = readdirSync(join(root, 'libwebcore')).filter((name) => name.endsWith('.c'))
  const objects = sources.map((name) => {
    const object = join(build, name.replace(/\.c$/, '.o'))
    execFileSync('wasixcc', ['-O2', '-I', join(root, 'libwebcore/include'), '-c', join(root, 'libwebcore', name), '-o', object], { env, stdio: 'inherit' })
    return object
  })
  const archive = join(build, 'libwebcore.a')
  execFileSync('wasixar', ['rcs', archive, ...objects], { env, stdio: 'inherit' })
  return {
    include: join(root, 'libwebcore/include'),
    ldflags: [`-L${build}`, ...WRAPPED.map((name) => `-Wl,--wrap=${name}`)],
    libs: ['webcore'],
  }
}

const stamp = join(dist, '.inputs')
const hash = inputsHash()
if (existsSync(stamp) && readFileSync(stamp, 'utf8') === hash && !process.argv.includes('--force')) {
  console.log('wasix-bin: up to date')
} else {
  const { env } = await toolchain()
  const libwebcore = buildLibwebcore(env)
  mkdirSync(dist, { recursive: true })
  for (const file of readdirSync(join(root, 'src')).filter((name) => name.endsWith('.c'))) {
    const out = join(dist, file.replace(/\.c$/, '.wasm'))
    execFileSync('wasixcc', ['-O2', join(root, 'src', file), '-o', out, ...libwebcore.ldflags, ...libwebcore.libs.map((lib) => `-l${lib}`)], { env, stdio: 'inherit' })
  }
  await buildBusybox(env, libwebcore)
  writeFileSync(stamp, hash)
  console.log(`wasix-bin: ${readdirSync(dist).filter((name) => !name.startsWith('.')).join(', ')}`)
}
