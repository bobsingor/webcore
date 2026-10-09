// Builds dist/node-lib.bin: [u32 index length][index JSON][UTF-8 sources] (ADR-0012).
// The index also carries Node's CLI option defaults and aliases (see options.mjs).
// Builtin ids follow Node's js2c: lib/fs.js → "fs", lib/internal/x.js → "internal/x",
// deps/a/b.js → "internal/deps/a/b". Files under overrides/ replace or add ids.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { extractOptions } from './options.mjs'

const root = new URL('..', import.meta.url).pathname
const vendor = join(root, 'vendor/node')
const sources = new Map()

function walk(dir, toId) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, toId)
    else if (name.endsWith('.js')) sources.set(toId(path), readFileSync(path, 'utf8'))
  }
}

walk(join(vendor, 'lib'), (path) => relative(join(vendor, 'lib'), path).replace(/\.js$/, ''))
walk(join(vendor, 'deps'), (path) => `internal/deps/${relative(join(vendor, 'deps'), path).replace(/\.js$/, '')}`)
sources.set('internal/deps/cjs-module-lexer/lexer', readFileSync(join(root, 'vendor/cjs-module-lexer/lexer.js'), 'utf8'))
const overridden = []
walk(join(root, 'overrides'), (path) => {
  const id = relative(join(root, 'overrides'), path).replace(/\.js$/, '')
  overridden.push(id)
  return id
})

const encoder = new TextEncoder()
const chunks = []
const entries = []
let offset = 0
for (const [id, source] of [...sources].sort(([a], [b]) => (a < b ? -1 : 1))) {
  const bytes = encoder.encode(source)
  entries.push([id, offset, bytes.length])
  chunks.push(bytes)
  offset += bytes.length
}

const version = readFileSync(join(vendor, 'VERSION'), 'utf8').trim()
const { options, aliases } = extractOptions(
  readFileSync(join(vendor, 'src/node_options.cc'), 'utf8'),
  readFileSync(join(vendor, 'src/node_options.h'), 'utf8'),
)
const index = encoder.encode(JSON.stringify({ version, entries, options, aliases }))
const out = new Uint8Array(4 + index.length + offset)
new DataView(out.buffer).setUint32(0, index.length, true)
out.set(index, 4)
let position = 4 + index.length
for (const chunk of chunks) {
  out.set(chunk, position)
  position += chunk.length
}

mkdirSync(join(root, 'dist'), { recursive: true })
writeFileSync(join(root, 'dist/node-lib.bin'), out)
console.log(
  `node-lib: Node ${version}, ${entries.length} builtins (${overridden.length} overridden), ` +
    `${Object.keys(options).length} options, ${(out.length / 1024 / 1024).toFixed(1)} MB`,
)
