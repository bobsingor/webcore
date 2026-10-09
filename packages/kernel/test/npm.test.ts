// webcore's npm (packages/userland/src/npm) against a fake registry: tree layout, lockfile, bins,
// scripts, npx, and ADR-0006's wasm32-wasi substitution.
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createShell, DEFAULT_ENV, type Kernel } from '../src/index.ts'
import { FakeRegistry } from './registry.ts'
import { boot, sh } from './helpers.ts'

const registry = new FakeRegistry([
  { name: 'left', version: '1.0.0', files: { 'index.js': "module.exports = 'left@1.0.0'" } },
  { name: 'left', version: '1.1.0', files: { 'index.js': "module.exports = 'left@1.1.0'" } },
  { name: 'left', version: '2.0.0', files: { 'index.js': "module.exports = 'left@2.0.0'" } },
  { name: 'left', version: '3.0.0-beta.1', files: { 'index.js': "module.exports = 'left@3 beta'" } },
  {
    name: 'uses-old-left',
    version: '1.0.0',
    manifest: { dependencies: { left: '^1.0.0' } },
    files: { 'index.js': "module.exports = require('left')" },
  },
  {
    name: 'tool',
    version: '1.0.0',
    manifest: { bin: { tool: 'bin/tool.js' }, dependencies: { left: '^2.0.0' } },
    files: { 'bin/tool.js': "#!/usr/bin/env node\nconsole.log('tool', process.argv.slice(2).join(' '), require('left'))\n" },
  },
  { name: 'peer-user', version: '1.0.0', manifest: { peerDependencies: { left: '>=2' } }, files: { 'index.js': "module.exports = require('left')" } },
  {
    name: 'native',
    version: '1.0.0',
    manifest: { optionalDependencies: { 'native-linux-x64-gnu': '1.0.0', 'native-darwin-arm64': '1.0.0' } },
    files: { 'index.js': "module.exports = require('native-wasm32-wasi')" },
  },
  { name: 'native-linux-x64-gnu', version: '1.0.0', manifest: { os: ['linux'], cpu: ['x64'] } },
  { name: 'native-wasm32-wasi', version: '1.0.0', manifest: { cpu: ['wasm32'] }, files: { 'index.js': "module.exports = 'wasm build'" } },
  { name: 'old', version: '1.0.0', meta: { deprecated: 'use new instead' } },
  { name: '@scope/util', version: '1.2.0', files: { 'index.js': "module.exports = 'scoped'" } },
  {
    name: 'create-thing',
    version: '1.0.0',
    manifest: { bin: 'bin/create.js' },
    files: {
      'bin/create.js': [
        '#!/usr/bin/env node',
        "const fs = require('fs')",
        'fs.mkdirSync(process.argv[2])',
        "fs.writeFileSync(process.argv[2] + '/made.txt', process.argv.slice(3).join(' ') + ' by ' + process.env.npm_config_user_agent.split(' ')[0])",
      ].join('\n'),
    },
  },
  { name: 'broken', version: '1.0.0', corrupt: true },
  { name: 'scripted', version: '1.0.0', meta: { hasInstallScript: true }, manifest: { scripts: { postinstall: 'exit 1' } } },
])

let kernel: Kernel
const decoder = new TextDecoder()

beforeAll(() => registry.start())
afterAll(() => registry.stop())

beforeEach(() => {
  kernel = boot()
  kernel.fs.mkdirp('/home/user/app')
})

afterEach(() => {
  kernel.shutdown()
})

function project(manifest: Record<string, unknown>): void {
  kernel.fs.writeFile('/home/user/app/package.json', `${JSON.stringify({ name: 'app', version: '1.0.0', ...manifest }, null, 2)}\n`)
}

function read(path: string): string {
  return decoder.decode(kernel.fs.readFile(`/home/user/app/${path}`))
}

function json(path: string) {
  return JSON.parse(read(path))
}

/** Runs a line in /home/user/app against the fake registry. */
function npm(line: string) {
  const shell = createShell({ cwd: '/home/user/app', env: { ...DEFAULT_ENV, PWD: '/home/user/app', npm_config_registry: registry.url } })
  return sh(kernel, line, shell)
}

describe('npm install', () => {
  it('lays out a hoisted tree with nested versions, peers and bins, and writes a lockfile', async () => {
    project({ dependencies: { left: '^2.0.0', 'uses-old-left': '^1.0.0', 'peer-user': '^1.0.0' }, devDependencies: { tool: '^1.0.0' } })
    const result = await npm('npm install')
    expect(result.stderr).toBe('')
    expect(result.stdout).toMatch(/^\nadded 5 packages in \d+m?s\n$/)

    expect(json('node_modules/left/package.json').version).toBe('2.0.0')
    expect(json('node_modules/uses-old-left/node_modules/left/package.json').version).toBe('1.1.0')
    expect(kernel.fs.readlink('/home/user/app/node_modules/.bin/tool')).toBe('../tool/bin/tool.js')

    const lock = json('package-lock.json')
    expect(lock.lockfileVersion).toBe(3)
    expect(Object.keys(lock.packages).sort()).toEqual([
      '',
      'node_modules/left',
      'node_modules/peer-user',
      'node_modules/tool',
      'node_modules/uses-old-left',
      'node_modules/uses-old-left/node_modules/left',
    ])
    expect(lock.packages['node_modules/tool']).toMatchObject({ version: '1.0.0', dev: true, bin: { tool: 'bin/tool.js' } })
    expect(lock.packages['node_modules/left'].integrity).toMatch(/^sha512-/)

    const run = await npm(`node -e "console.log(require('left'), require('uses-old-left'), require('peer-user'))"`)
    expect(run.stdout).toBe('left@2.0.0 left@1.1.0 left@2.0.0\n')
  })

  it('adds, reinstalls from the lockfile without asking the registry, and removes', async () => {
    project({ dependencies: { 'uses-old-left': '^1.0.0' } })
    expect((await npm('npm install @scope/util')).code).toBe(0)
    expect(json('package.json').dependencies).toEqual({ '@scope/util': '^1.2.0', 'uses-old-left': '^1.0.0' })
    expect(await npm(`node -p "require('@scope/util')"`)).toMatchObject({ stdout: 'scoped\n' })

    registry.requests.length = 0
    expect((await npm('npm install')).stdout).toMatch(/up to date/)
    expect((await npm('npm ci')).code).toBe(0)
    expect(registry.requests).toEqual([])

    const removed = await npm('npm uninstall uses-old-left')
    expect(removed.stdout).toMatch(/removed 2 packages/)
    expect(kernel.fs.tryLookup('/home/user/app/node_modules/uses-old-left')).toBeUndefined()
    expect(Object.keys(json('package-lock.json').packages)).toEqual(['', 'node_modules/@scope/util'])
  })

  it('installs wasm32-wasi builds instead of native binaries (ADR-0006)', async () => {
    project({ dependencies: { native: '1.0.0' } })
    registry.requests.length = 0
    expect((await npm('npm install')).stdout).toMatch(/added 2 packages/)
    expect(await npm(`node -p "require('native')"`)).toMatchObject({ stdout: 'wasm build\n' })
    expect(kernel.fs.tryLookup('/home/user/app/node_modules/native-linux-x64-gnu')).toBeUndefined()
    // Other platforms' binaries are skipped by name, without fetching their metadata.
    expect(registry.requests.filter((path) => path.includes('linux-x64') || path.includes('darwin'))).toEqual([])
  })

  it('reports registry errors, integrity failures, deprecations and skipped scripts', async () => {
    project({})
    const missing = await npm('npm install does-not-exist')
    expect(missing.code).toBe(1)
    expect(missing.stderr).toMatch(/^npm error code E404\nnpm error 404 Not Found/)

    const corrupt = await npm('npm install broken')
    expect(corrupt.code).toBe(1)
    expect(corrupt.stderr).toContain('npm error code EINTEGRITY')

    const deprecated = await npm('npm install old scripted')
    expect(deprecated.code).toBe(0)
    expect(deprecated.stderr).toContain('npm warn deprecated old@1.0.0: use new instead')
    expect(deprecated.stderr).toContain('npm warn skipped install scripts of 1 package (not supported yet): scripted@1.0.0')
  })
})

describe('npm run', () => {
  beforeEach(async () => {
    project({
      devDependencies: { tool: '^1.0.0' },
      scripts: {
        pretest: 'echo pre',
        test: 'tool hello',
        build: 'echo $npm_package_name@$npm_package_version $npm_lifecycle_event && echo done',
        fail: 'exit 7',
      },
    })
    await npm('npm install')
  })

  it('runs scripts with pre/post hooks, node_modules/.bin on PATH and npm’s environment', async () => {
    const test = await npm('npm test -- extra')
    expect(test.stdout).toBe('\n> app@1.0.0 pretest\n> echo pre\n\npre\n\n> app@1.0.0 test\n> tool hello extra\n\ntool hello extra left@2.0.0\n')
    expect((await npm('npm run build --silent')).stdout).toBe('app@1.0.0 build\ndone\n')
    expect((await npm('npm run fail')).code).toBe(7)

    const missing = await npm('npm run nope')
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('npm error Missing script: "nope"')
    expect((await npm('npm run')).stdout).toContain('Scripts available in app@1.0.0 via `npm run-script`:\n  pretest\n    echo pre\n')
  })

  it('runs local bins with npx and npm exec', async () => {
    expect((await npm('npx tool a b')).stdout).toBe('tool a b left@2.0.0\n')
    expect((await npm('npm exec -- tool c')).stdout).toBe('tool c left@2.0.0\n')
  })
})

describe('npx and npm init', () => {
  it('installs initializers into its cache and runs them', async () => {
    const created = await npm('npm create thing my-dir -- --flag x')
    expect(created.code).toBe(0)
    expect(created.stderr).toContain('will be installed: create-thing@1.0.0')
    expect(read('my-dir/made.txt')).toBe('--flag x by npm/11.6.2')

    registry.requests.length = 0
    expect((await npm('npx create-thing other')).code).toBe(0)
    expect(read('other/made.txt')).toBe(' by npm/11.6.2')
    // The second run reuses the cached install.
    expect(registry.requests.filter((path) => path.endsWith('.tgz'))).toEqual([])
  })
})
