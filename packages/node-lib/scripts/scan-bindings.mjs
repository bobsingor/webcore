// Reports which internalBinding() properties Node's lib/ uses.
// Usage: node scripts/scan-bindings.mjs [lib-dir] [--json]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
const root = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : new URL('../vendor/node/lib', import.meta.url).pathname
const files = []
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') && files.push(p) } }
walk(root)
const usage = new Map()
const add = (b, prop, file) => { if (!usage.has(b)) usage.set(b, new Map()); const m = usage.get(b); if (prop) m.set(prop, (m.get(prop) ?? new Set()).add(file.slice(root.length + 1))) }
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  // const { a, b: c } = internalBinding('x')
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*internalBinding\(\s*'([^']+)'\s*\)/g)) {
    add(m[2], null, file)
    for (const part of m[1].split(',')) { const name = part.split(':')[0].trim(); if (name && !name.startsWith('...')) add(m[2], name, file) }
  }
  // const x = internalBinding('y'); then x.prop
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*internalBinding\(\s*'([^']+)'\s*\)/g)) {
    add(m[2], null, file)
    for (const p of src.matchAll(new RegExp(`\\b${m[1]}\\.(\\w+)`, 'g'))) add(m[2], p[1], file)
  }
  // internalBinding('x').prop
  for (const m of src.matchAll(/internalBinding\(\s*'([^']+)'\s*\)\.(\w+)/g)) add(m[1], m[2], file)
  for (const m of src.matchAll(/internalBinding\(\s*'([^']+)'\s*\)/g)) add(m[1], null, file)
}
const rows = [...usage].map(([b, props]) => [b, props.size]).sort((a, b) => b[1] - a[1])
let total = 0
for (const [b, n] of rows) { total += n; console.log(String(n).padStart(4), b) }
console.log(`${usage.size} bindings, ${total} properties`)
if (process.argv.includes('--json')) console.log(JSON.stringify(Object.fromEntries([...usage].map(([b, p]) => [b, [...p.keys()].sort()])), null, 1))
