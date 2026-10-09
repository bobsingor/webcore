// The WASIX C toolchain at pinned versions (M2c): wasixcc, WASIX's LLVM, the WASIX libc sysroot
// (the exception-handling variant: setjmp/longjmp as Wasm exceptions, no Asyncify) and binaryen.
// Downloaded once into node_modules/.cache/wasixcc.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const VERSIONS = {
  wasixcc: 'v0.4.7',
  llvm: '21.1.206',
  sysroot: 'v2026-10-02.1',
  binaryen: 'version_133',
}

const PLATFORMS = {
  'darwin-arm64': { wasixcc: 'aarch64-apple-darwin', llvm: 'MacOS-aarch64', binaryen: 'arm64-macos' },
  'darwin-x64': { wasixcc: 'x86_64-apple-darwin', llvm: 'MacOS-x86_64', binaryen: 'x86_64-macos' },
  'linux-x64': { wasixcc: 'x86_64-unknown-linux-gnu', llvm: 'Linux-x86_64', binaryen: 'x86_64-linux' },
  'linux-arm64': { wasixcc: 'aarch64-unknown-linux-gnu', llvm: 'Linux-aarch64', binaryen: 'aarch64-linux' },
}

const cache = new URL('../node_modules/.cache/wasixcc/', import.meta.url).pathname

async function fetchTarball(url, into, strip = 0) {
  mkdirSync(cache, { recursive: true })
  const file = join(cache, 'download.tar.gz')
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  writeFileSync(file, new Uint8Array(await response.arrayBuffer()))
  mkdirSync(into, { recursive: true })
  execFileSync('tar', ['-xzf', file, '-C', into, ...(strip ? [`--strip-components=${strip}`] : [])])
  rmSync(file)
}

/** Ensures the toolchain; returns the environment that runs wasixcc against it. */
export async function toolchain() {
  const platform = PLATFORMS[`${process.platform}-${process.arch}`]
  if (!platform) throw new Error(`no WASIX toolchain for ${process.platform}-${process.arch}`)
  const root = join(cache, `${VERSIONS.wasixcc}-${VERSIONS.llvm}-${VERSIONS.sysroot}-${VERSIONS.binaryen}`)
  const ready = join(root, '.ready')
  if (!existsSync(ready)) {
    console.log(`Downloading the WASIX toolchain into ${root}…`)
    rmSync(root, { recursive: true, force: true })
    const github = 'https://github.com'
    await fetchTarball(`${github}/wasix-org/wasixcc/releases/download/${VERSIONS.wasixcc}/wasixcc-${platform.wasixcc}.tar.gz`, join(root, 'wasixcc'))
    await fetchTarball(`${github}/wasix-org/llvm-project/releases/download/${VERSIONS.llvm}/LLVM-${platform.llvm}.tar.gz`, join(root, 'llvm'))
    // wasix-sysroot-exnref-eh/sysroot/… → sysroot/sysroot-exnref-eh/…, where SYSROOT_PREFIX looks.
    await fetchTarball(`${github}/wasix-org/wasix-libc/releases/download/${VERSIONS.sysroot}/sysroot-exnref-eh.tar.gz`, join(root, 'sysroot/sysroot-exnref-eh'), 2)
    await fetchTarball(`${github}/WebAssembly/binaryen/releases/download/${VERSIONS.binaryen}/binaryen-${VERSIONS.binaryen}-${platform.binaryen}.tar.gz`, join(root, 'binaryen'), 1)
    execFileSync(join(root, 'wasixcc/wasixccenv'), ['install-executables', join(root, 'bin')], { env: { ...process.env, HOME: root } })
    writeFileSync(ready, `${JSON.stringify(VERSIONS)}\n`)
  }
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    WASIXCC_LLVM_LOCATION: join(root, 'llvm'),
    WASIXCC_SYSROOT_PREFIX: join(root, 'sysroot'),
    WASIXCC_BINARYEN_LOCATION: join(root, 'binaryen'),
    // wasixcc enables relaxed SIMD, which not every browser has; plain SIMD is everywhere.
    WASIXCC_COMPILER_POST_FLAGS: '-mno-relaxed-simd',
  }
  return { root, bin: join(root, 'bin'), env }
}
