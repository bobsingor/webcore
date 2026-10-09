// Fetches Node's JavaScript sources at the pinned tag into vendor/node (ADR-0012).
// Usage: node scripts/vendor.mjs [--from <existing checkout>]
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const NODE_VERSION = 'v24.21.0'

// The JavaScript that Node compiles into its binary: lib/ plus `deps_files` from node.gyp.
const PATHS = [
  'lib',
  'deps/acorn/acorn/dist/acorn.js',
  'deps/acorn/acorn/LICENSE',
  'deps/acorn/acorn-walk/dist/walk.js',
  'deps/acorn/acorn-walk/LICENSE',
  'deps/minimatch/index.js',
  'deps/minimatch/LICENSE.md',
  'LICENSE',
  // Read at build time to derive CLI option defaults; not part of the bundle.
  'src/node_options.cc',
  'src/node_options.h',
]

const target = new URL('../vendor/node/', import.meta.url).pathname
const fromIndex = process.argv.indexOf('--from')
let checkout = fromIndex > 0 ? process.argv[fromIndex + 1] : undefined
let temporary

if (!checkout) {
  temporary = mkdtempSync(join(tmpdir(), 'webcore-node-'))
  checkout = join(temporary, 'node')
  const git = (...args) => execFileSync('git', args, { stdio: 'inherit' })
  git('clone', '--quiet', '--depth', '1', '--branch', NODE_VERSION, '--filter=blob:none', '--sparse',
    'https://github.com/nodejs/node', checkout)
  git('-C', checkout, 'sparse-checkout', 'set', '--no-cone', ...PATHS.map((path) => `/${path}`))
}

rmSync(target, { recursive: true, force: true })
for (const path of PATHS) {
  const source = join(checkout, path)
  if (!existsSync(source)) throw new Error(`missing ${path} in ${checkout}`)
  cpSync(source, join(target, path), { recursive: true })
}
// Lint configuration is not part of the runtime.
rmSync(join(target, 'lib/eslint.config_partial.mjs'), { force: true })
writeFileSync(join(target, 'VERSION'), `${NODE_VERSION}\n`)
if (temporary) rmSync(temporary, { recursive: true, force: true })
console.log(`vendored Node ${NODE_VERSION} into ${target}`)
