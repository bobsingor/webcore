import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { nodeProcessHost } from '../src/host/node.ts'
import { createShell, DEFAULT_ENV, installRootfs, Kernel, runLine, type Shell } from '../src/index.ts'

const require = createRequire(import.meta.url)
const binDir = join(dirname(require.resolve('@webcore/wat-bin/package.json')), 'dist')

export const binaries: Record<string, Uint8Array> = Object.fromEntries(
  readdirSync(binDir)
    .filter((file) => file.endsWith('.wasm'))
    .map((file) => [file.slice(0, -'.wasm'.length), new Uint8Array(readFileSync(join(binDir, file)))]),
)

export function boot(): Kernel {
  const kernel = new Kernel({ host: nodeProcessHost() })
  installRootfs(kernel, binaries)
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
