// ES modules (M1b): Node's own ESM loader over the generator transform in
// src/personalities/node/esm.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Kernel } from '../src/index.ts'
import { boot, sh } from './helpers.ts'

let kernel: Kernel

beforeEach(() => {
  kernel = boot()
})

afterEach(() => {
  kernel.shutdown()
})

function files(tree: Record<string, string>): void {
  for (const [path, content] of Object.entries(tree)) {
    const absolute = `/home/user/${path}`
    kernel.fs.mkdirp(absolute.slice(0, absolute.lastIndexOf('/')))
    kernel.fs.writeFile(absolute, content)
  }
}

describe('ES modules', () => {
  it('links imports, exports and live bindings', async () => {
    files({
      'lib.mjs': [
        'export let count = 1',
        'export function inc() { count++ }',
        "export default 'dflt'",
        "export const { a, b: [c] } = { a: 'A', b: ['C'] }",
        "export class Widget { static kind = 'w' }",
        "export * from './more.mjs'",
        "export * as more from './more.mjs'",
      ].join('\n'),
      'more.mjs': "export const extra = 'extra'\nexport { inc as increment } from './lib.mjs'",
      'main.mjs': [
        "import def, { count, inc, a, c, Widget, extra, increment, more } from './lib.mjs'",
        'console.log(def, count, a, c, Widget.kind, extra, more.extra)',
        'inc(); increment()',
        'console.log(count, more.increment === inc, Object.keys(more))',
      ].join('\n'),
    })
    expect((await sh(kernel, 'node main.mjs')).stdout).toBe("dflt 1 A C w extra extra\n3 true [ 'extra', 'increment' ]\n")
  })

  it('leaves shadowed names alone when rewriting imports', async () => {
    files({
      'dep.mjs': "export const value = 'imported'\nexport function helper() { return 'helped' }",
      'shadow.mjs': [
        "import { value, helper as h } from './dep.mjs'",
        'const fromParam = (value) => value + 1',
        "function local() { const value = 'local'; return value }",
        'const seen = []',
        "for (const value of ['loop']) seen.push(value)",
        "for (const value in { key: 1 }) seen.push(value)",
        "try { throw 'caught' } catch (value) { seen.push(value) }",
        "class K { value = 'field'; method() { return value } }",
        'const shorthand = { value, h }',
        'console.log(fromParam(1), local(), seen.join(), new K().value, new K().method(), shorthand.value, shorthand.h())',
      ].join('\n'),
    })
    expect((await sh(kernel, 'node shadow.mjs')).stdout).toBe('2 local loop,key,caught field imported imported helped\n')
  })

  it('names every form of default export "default"', async () => {
    files({
      'fn.mjs': "export default function () { return 'fn' }",
      'cls.mjs': 'export default class { ok = true }',
      'arrow.mjs': "export default () => 'arrow'",
      'expr.mjs': 'export default 6 * 7',
      'main.mjs': [
        "import fn from './fn.mjs'; import cls from './cls.mjs'; import arrow from './arrow.mjs'; import expr from './expr.mjs'",
        'console.log(fn.name, fn(), cls.name, new cls().ok, arrow.name, arrow(), expr)',
      ].join('\n'),
    })
    expect((await sh(kernel, 'node main.mjs')).stdout).toBe('default fn default true default arrow 42\n')
  })

  it('hoists functions across cycles, before either module evaluates', async () => {
    files({
      'a.mjs': "import { b } from './b.mjs'\nexport function a() { return 'a' }\nconsole.log('a sees', b())",
      'b.mjs': "import { a } from './a.mjs'\nexport function b() { return 'b+' + a() }\nconsole.log('b sees', a())",
    })
    expect((await sh(kernel, 'node a.mjs')).stdout).toBe('b sees a\na sees b+a\n')
  })

  it('supports top-level await', async () => {
    files({ 'tla.mjs': "const value = await new Promise((resolve) => setTimeout(() => resolve('awaited'), 20))\nconsole.log(value)" })
    expect((await sh(kernel, 'node tla.mjs')).stdout).toBe('awaited\n')
  })

  it('initializes import.meta and supports JSON modules and import()', async () => {
    files({
      'data.json': '{ "ok": true }',
      'dep.mjs': "export const value = 'imported'",
      'main.mjs': [
        "import data from './data.json' with { type: 'json' }",
        "const lazy = await import('./dep.mjs')",
        "console.log(import.meta.url, import.meta.dirname, import.meta.filename, import.meta.resolve('./dep.mjs'))",
        'console.log(data.ok, lazy.value, Object.prototype.toString.call(lazy))',
      ].join('\n'),
    })
    expect((await sh(kernel, 'node main.mjs')).stdout).toBe(
      'file:///home/user/main.mjs /home/user /home/user/main.mjs file:///home/user/dep.mjs\ntrue imported [object Module]\n',
    )
  })
})

describe('CommonJS interop', () => {
  beforeEach(() => {
    files({
      'node_modules/cjs-dep/package.json': '{ "name": "cjs-dep", "main": "index.js" }',
      'node_modules/cjs-dep/index.js': "exports.named = 'named-cjs'",
      'node_modules/dual/package.json': '{ "name": "dual", "exports": { "import": "./index.mjs", "require": "./index.cjs" } }',
      'node_modules/dual/index.mjs': "export default 'dual-esm'",
      'node_modules/dual/index.cjs': "module.exports = 'dual-cjs'",
      'node_modules/esm-only/package.json': '{ "name": "esm-only", "type": "module", "exports": "./index.js" }',
      'node_modules/esm-only/index.js': "export const hello = 'from esm'\nexport default function greet() { return 'hi' }",
    })
  })

  it('imports CommonJS with named exports detected by the lexer', async () => {
    files({ 'main.mjs': "import cjs, { named } from 'cjs-dep'\nimport dual from 'dual'\nconsole.log(cjs.named, named, dual)" })
    expect((await sh(kernel, 'node main.mjs')).stdout).toBe('named-cjs named-cjs dual-esm\n')
  })

  it('requires ES modules synchronously and imports them dynamically', async () => {
    files({
      'main.cjs': [
        "const esm = require('esm-only')",
        "console.log(esm.hello, esm.default(), esm.__esModule, require('dual'))",
        "import('esm-only').then((m) => console.log('import()', m.hello))",
      ].join('\n'),
    })
    expect((await sh(kernel, 'node main.cjs')).stdout).toBe('from esm hi true dual-cjs\nimport() from esm\n')
  })

  it('handles import() in -e scripts and --input-type=module', async () => {
    expect((await sh(kernel, `node -e "import('esm-only').then((m) => console.log(m.hello))"`)).stdout).toBe('from esm\n')
    expect((await sh(kernel, `node --input-type=module -e "import { hello } from 'esm-only'; console.log(hello, import.meta.url)"`)).stdout).toBe(
      'from esm file:///home/user/[eval1]\n',
    )
  })
})

describe('errors', () => {
  it('reports syntax errors, missing exports and runtime errors like Node', async () => {
    files({
      'syntax.mjs': 'const x = 1\nexport const y = x +\n',
      'dep.mjs': 'export const ok = 1',
      'missing.mjs': "import { nope } from './dep.mjs'",
      'throws.mjs': "export const ok = 1\n\nfunction fail() {\n  throw new Error('thrown in esm')\n}\nfail()\n",
    })
    const syntax = await sh(kernel, 'node syntax.mjs')
    expect(syntax.code).toBe(1)
    expect(syntax.stderr).toContain('SyntaxError')
    expect(syntax.stderr).toContain('file:///home/user/syntax.mjs:3')

    const missing = await sh(kernel, 'node missing.mjs')
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain("SyntaxError: The requested module './dep.mjs' does not provide an export named 'nope'")

    const thrown = await sh(kernel, 'node throws.mjs')
    expect(thrown.code).toBe(1)
    expect(thrown.stderr).toMatch(/^Error: thrown in esm\n {4}at fail \(file:\/\/\/home\/user\/throws\.mjs:4:9\)\n {4}at file:\/\/\/home\/user\/throws\.mjs:6:1\n/)
  })
})

describe('M1b acceptance', () => {
  it('runs create-vite to scaffold a React app', async () => {
    const tarball = new Uint8Array(readFileSync(new URL('./fixtures/create-vite-9.2.1.tgz', import.meta.url)))
    expect(await kernel.extract(tarball, '/opt/create-vite', { strip: 1 })).toBeGreaterThan(50)

    const result = await sh(kernel, 'node /opt/create-vite/index.js my-app --template react --no-interactive --no-immediate')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Scaffolding project in /home/user/my-app')
    expect(result.stdout).toContain('npm run dev')

    const manifest = JSON.parse(new TextDecoder().decode(kernel.fs.readFile('/home/user/my-app/package.json')))
    expect(manifest).toMatchObject({ name: 'my-app', type: 'module', scripts: { dev: 'vite' } })
    expect(Object.keys(manifest.devDependencies)).toContain('vite')
    expect(kernel.fs.lookup('/home/user/my-app/src/App.jsx').kind).toBe('file')
    expect(kernel.fs.lookup('/home/user/my-app/.gitignore').kind).toBe('file')
  })
})
