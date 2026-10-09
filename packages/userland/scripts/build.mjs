// Builds dist/userland.json: the files webcore installs into its root filesystem (installRootfs).
// Each TypeScript module is stripped to JavaScript (types become whitespace, so line numbers in
// stack traces match the source) and lands under /usr/lib/webcore; executables are symlinks.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'src')
const PREFIX = '/usr/lib/webcore'

// Executables: VFS path → module (relative to src).
const LINKS = {
  '/bin/sh': 'sh/main.ts',
  '/usr/bin/npm': 'npm/bin/npm.ts',
  '/usr/bin/npx': 'npm/bin/npx.ts',
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) yield path
  }
}

const files = { [`${PREFIX}/package.json`]: `${JSON.stringify({ type: 'module' }, null, 2)}\n` }
for (const path of walk(src)) {
  const source = readFileSync(path, 'utf8')
  // Relative imports name .ts files; the output is .js.
  const code = stripTypeScriptTypes(source, { mode: 'strip' }).replace(
    /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g,
    (_, keyword, quote, specifier) => `${keyword}${quote}${specifier}.js${quote}`,
  )
  files[`${PREFIX}/${relative(src, path).replace(/\.ts$/, '.js')}`] = code
}

const links = Object.fromEntries(Object.entries(LINKS).map(([path, module]) => [path, `${PREFIX}/${module.replace(/\.ts$/, '.js')}`]))
for (const target of Object.values(links)) if (!files[target]) throw new Error(`missing program ${target}`)

mkdirSync(join(root, 'dist'), { recursive: true })
writeFileSync(join(root, 'dist/userland.json'), JSON.stringify({ files, links }))
console.log(`userland: ${Object.keys(files).length} files, ${Object.keys(links).length} programs`)
