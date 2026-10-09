// Runs command lines headless, for development: node scripts/run.ts '<shell line>' ['<shell line>' …]
// Requires Node ≥ 22.18 or --experimental-strip-types.
import { readdirSync, readFileSync } from 'node:fs'
import { nodeProcessHost } from '../src/host/node.ts'
import { busyboxLinks, createShell, DEFAULT_ENV, installRootfs, Kernel, runLine } from '../src/index.ts'

const root = new URL('../../', import.meta.url)
const kernel = new Kernel({ host: nodeProcessHost() })
kernel.addAsset('node-lib', new Uint8Array(readFileSync(new URL('node-lib/dist/node-lib.bin', root))))
installRootfs(kernel, {
  busybox: {
    binary: new Uint8Array(readFileSync(new URL('wasix-bin/dist/busybox.wasm', root))),
    links: busyboxLinks(readFileSync(new URL('wasix-bin/dist/busybox.links', root), 'utf8')),
  },
  userland: JSON.parse(readFileSync(new URL('userland/dist/userland.json', root), 'utf8')),
})
// WEBCORE_FIXTURE=<host dir> copies that directory into /home/user first.
if (process.env.WEBCORE_FIXTURE) {
  const copy = (from: string, to: string) => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        kernel.fs.mkdirp(`${to}/${entry.name}`)
        copy(`${from}/${entry.name}`, `${to}/${entry.name}`)
      } else kernel.fs.writeFile(`${to}/${entry.name}`, new Uint8Array(readFileSync(`${from}/${entry.name}`)))
    }
  }
  copy(process.env.WEBCORE_FIXTURE, '/home/user')
}
const passthrough = Object.entries(process.env).filter(([k]) => k.startsWith('WEBCORE_') || k.startsWith('npm_config_'))
const env = { ...DEFAULT_ENV, PWD: '/home/user', ...Object.fromEntries(passthrough) }
const lines = process.argv.length > 2 ? process.argv.slice(2) : ['node -e "console.log(1)"']
for (const line of lines) {
  if (lines.length > 1) process.stdout.write(`\n$ ${line}\n`)
  const started = performance.now()
  const code = await runLine(kernel, createShell({ cwd: '/home/user', env }), line, {
    onStdout: (chunk) => process.stdout.write(chunk),
    onStderr: (chunk) => process.stderr.write(chunk),
  })
  process.stderr.write(`[exit ${code} · ${(performance.now() - started).toFixed(0)} ms]\n`)
}
kernel.shutdown()
process.exit(0)
