// Runs Node's own test/parallel on webcore, as Node's tools/test.py would: each file is a process,
// `node [// Flags:] test/parallel/<file>` from the repository root, and exit status 0 passes.
//
//   node scripts/node-tests.ts                    the tests in test/node-parallel.txt: must all pass
//   node scripts/node-tests.ts --all [filter…]    every test (or those matching a filter): a report
//   node scripts/node-tests.ts --all --update     … and rewrite test/node-parallel.txt
//
// Node's tests aren't vendored. They're fetched at the pinned tag into node_modules/.cache.
// Requires Node ≥ 22.18 or --experimental-strip-types.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nodeProcessHost } from '../src/host/node.ts'
import { busyboxLinks, DEFAULT_ENV, exec, installRootfs, Kernel } from '../src/index.ts'

const NODE_VERSION = 'v24.21.0'
const TIMEOUT_MS = 60_000
const CONCURRENCY = 6
const OUTPUT_LIMIT = 2000

const packageRoot = new URL('..', import.meta.url).pathname
const workspace = new URL('../../', import.meta.url).pathname
const cache = join(packageRoot, 'node_modules/.cache/node-tests', NODE_VERSION)
const passList = join(packageRoot, 'test/node-parallel.txt')
const args = process.argv.slice(2)
const all = args.includes('--all')
const update = args.includes('--update')
const filters = args.filter((arg) => !arg.startsWith('--'))

function fetchTests(): void {
  if (existsSync(join(cache, 'test/parallel'))) return
  console.log(`Fetching Node ${NODE_VERSION}'s tests into ${cache}…`)
  mkdirSync(cache, { recursive: true })
  const git = (...gitArgs: string[]) => execFileSync('git', gitArgs, { stdio: ['ignore', 'ignore', 'inherit'] })
  git('-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', NODE_VERSION, '--filter=blob:none', '--sparse', 'https://github.com/nodejs/node', cache)
  git('-C', cache, 'sparse-checkout', 'set', '--no-cone', '/test/common', '/test/fixtures', '/test/parallel')
}

function boot(): Kernel {
  const kernel = new Kernel({ host: nodeProcessHost({ warmWorkers: CONCURRENCY }) })
  kernel.addAsset('node-lib', new Uint8Array(readFileSync(join(workspace, 'node-lib/dist/node-lib.bin'))))
  installRootfs(kernel, {
    busybox: {
      binary: new Uint8Array(readFileSync(join(workspace, 'wasix-bin/dist/busybox.wasm'))),
      links: busyboxLinks(readFileSync(join(workspace, 'wasix-bin/dist/busybox.links'), 'utf8')),
    },
    userland: JSON.parse(readFileSync(join(workspace, 'userland/dist/userland.json'), 'utf8')),
  })
  // The repository root, as Node's test runner sees it: /node/test/{common,fixtures,parallel}.
  const copy = (from: string, to: string) => {
    kernel.fs.mkdirp(to)
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) copy(join(from, entry.name), `${to}/${entry.name}`)
      else if (entry.isFile()) kernel.fs.writeFile(`${to}/${entry.name}`, new Uint8Array(readFileSync(join(from, entry.name))))
    }
  }
  for (const dir of ['common', 'fixtures', 'parallel']) copy(join(cache, 'test', dir), `/node/test/${dir}`)
  return kernel
}

/** `// Flags: --foo --bar` in a test's header. */
function flagsOf(source: string): string[] {
  const match = /^\/\/ Flags:(.*)$/m.exec(source.slice(0, 2000))
  return match ? match[1].trim().split(/\s+/).filter(Boolean) : []
}

type Outcome = 'pass' | 'skip' | 'fail' | 'timeout'

async function runTest(kernel: Kernel, file: string, slot: number): Promise<{ outcome: Outcome; ms: number; output: string }> {
  const source = readFileSync(join(cache, 'test/parallel', file), 'utf8')
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
  const started = performance.now()
  let output = ''
  const collect = (chunk: Uint8Array) => {
    if (output.length < OUTPUT_LIMIT) output += new TextDecoder().decode(chunk)
  }
  try {
    const { code, stdout } = await exec(kernel, ['node', ...flagsOf(source), `test/parallel/${file}`], {
      cwd: '/node',
      env: { ...DEFAULT_ENV, PWD: '/node', TEST_THREAD_ID: String(slot), NODE_TEST_KNOWN_GLOBALS: '0' },
      signal: abort.signal,
      onStdout: collect,
      onStderr: collect,
    })
    const ms = Math.round(performance.now() - started)
    if (abort.signal.aborted) return { outcome: 'timeout', ms, output }
    if (code !== 0) return { outcome: 'fail', ms, output: `exit ${code}\n${output}` }
    return { outcome: /^1\.\.0 # Skipped/m.test(stdout) ? 'skip' : 'pass', ms, output }
  } finally {
    clearTimeout(timer)
  }
}

fetchTests()
const allTests = readdirSync(join(cache, 'test/parallel'))
  .filter((file) => /^test-.*\.(c|m)?js$/.test(file))
  .sort()
const expected = existsSync(passList) ? readFileSync(passList, 'utf8').split('\n').filter((line) => line && !line.startsWith('#')) : []
let selected = all ? allTests : expected
if (filters.length) selected = selected.filter((file) => filters.some((filter) => file.includes(filter)))
if (!selected.length) {
  console.log(all ? 'No tests match.' : `${passList} lists no tests yet: run with --all --update.`)
  process.exit(1)
}

console.log(`Running ${selected.length} of ${allTests.length} test/parallel files (Node ${NODE_VERSION})…`)
const kernel = boot()
const results = new Map<string, Awaited<ReturnType<typeof runTest>>>()
const started = performance.now()
let next = 0
await Promise.all(
  Array.from({ length: CONCURRENCY }, async (_, slot) => {
    while (next < selected.length) {
      const file = selected[next++]
      const result = await runTest(kernel, file, slot)
      results.set(file, result)
      if (results.size % 100 === 0) console.log(`  ${results.size}/${selected.length}`)
    }
  }),
)
kernel.shutdown()

const by = (outcome: Outcome) => [...results].filter(([, result]) => result.outcome === outcome).map(([file]) => file)
const passed = [...by('pass'), ...by('skip')].sort()
console.log(
  `\n${by('pass').length} passed, ${by('skip').length} skipped, ${by('fail').length} failed, ${by('timeout').length} timed out ` +
    `in ${Math.round((performance.now() - started) / 1000)} s`,
)
writeFileSync(join(cache, 'results.json'), JSON.stringify(Object.fromEntries(results), null, 2))
console.log(`Details: ${join(cache, 'results.json')}`)

if (update) {
  const header = `# Node ${NODE_VERSION} test/parallel files that pass on webcore (scripts/node-tests.ts --all --update).\n`
  writeFileSync(passList, `${header}${passed.join('\n')}\n`)
  console.log(`Wrote ${passed.length} tests to ${passList}`)
}
const regressions = expected.filter((file) => selected.includes(file) && !passed.includes(file))
if (regressions.length) {
  console.log(`\n${regressions.length} listed tests no longer pass:`)
  for (const file of regressions) console.log(`  ${file}: ${results.get(file)?.output.split('\n').slice(0, 3).join(' | ')}`)
  if (!update) process.exit(1)
}
process.exit(0)
