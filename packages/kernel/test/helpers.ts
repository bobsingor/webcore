import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import initWabt from 'wabt'
import { nodeProcessHost } from '../src/host/node.ts'
import { busyboxLinks, createShell, DEFAULT_ENV, installRootfs, Kernel, runLine, type Shell, type Userland } from '../src/index.ts'

const require = createRequire(import.meta.url)
const wasixDir = join(dirname(require.resolve('@webcore/wasix-bin/package.json')), 'dist')
const nodeLib = new Uint8Array(readFileSync(join(dirname(require.resolve('@webcore/node-lib/package.json')), 'dist/node-lib.bin')))
export const userland: Userland = JSON.parse(readFileSync(join(dirname(require.resolve('@webcore/userland/package.json')), 'dist/userland.json'), 'utf8'))

export const busybox = {
  binary: new Uint8Array(readFileSync(join(wasixDir, 'busybox.wasm'))),
  links: busyboxLinks(readFileSync(join(wasixDir, 'busybox.links'), 'utf8')),
}

/** The WASIX test programs (packages/wasix-bin/src), installed into /usr/bin. */
export const programs: Record<string, Uint8Array> = Object.fromEntries(
  readdirSync(wasixDir)
    .filter((file) => file.endsWith('.wasm') && file !== 'busybox.wasm')
    .map((file) => [file.slice(0, -'.wasm'.length), new Uint8Array(readFileSync(join(wasixDir, file)))]),
)

/**
 * Plain WASI preview1 programs (test/fixtures/wasi: echo, cat), assembled from WAT: modules
 * without WASIX, as node:wasi and other toolchains produce.
 */
export async function wasiFixtures(): Promise<Record<string, Uint8Array>> {
  const wabt = await initWabt()
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/wasi')
  return Object.fromEntries(
    readdirSync(dir)
      .filter((file) => file.endsWith('.wat'))
      .map((file) => {
        const module = wabt.parseWat(file, readFileSync(join(dir, file), 'utf8'))
        try {
          return [`wasi-${file.slice(0, -'.wat'.length)}`, module.toBinary({}).buffer]
        } finally {
          module.destroy()
        }
      }),
  )
}

export function boot(): Kernel {
  const kernel = new Kernel({ host: nodeProcessHost(), assets: { 'node-lib': nodeLib } })
  installRootfs(kernel, { busybox, programs, userland })
  return kernel
}

export function newShell(): Shell {
  return createShell({ cwd: '/home/user', env: { ...DEFAULT_ENV, PWD: '/home/user' } })
}

/** Runs a shell line and collects its output. */
export async function sh(kernel: Kernel, line: string, shell = newShell()) {
  const out = new TextDecoder()
  const err = new TextDecoder()
  let stdout = ''
  let stderr = ''
  const code = await runLine(kernel, shell, line, {
    onStdout: (chunk) => (stdout += out.decode(chunk, { stream: true })),
    onStderr: (chunk) => (stderr += err.decode(chunk, { stream: true })),
  })
  return { code, stdout, stderr, shell }
}
