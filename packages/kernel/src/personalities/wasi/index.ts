// WASI preview1 personality (ADR-0004): a WASI command as a process. Preopens follow the wasmtime
// convention: fd 3 is "/", fd 4 is the working directory.
import type { BootMessage } from '../../abi/protocol.ts'
import type { SyscallClient } from '../../process/syscalls.ts'
import { createPreview1, WASI_ENOSYS } from './preview1.ts'

export function runWasi(boot: BootMessage, sys: SyscallClient): never {
  const module = boot.module
  if (!module) throw new Error('missing Wasm module')
  const encoder = new TextEncoder()

  let memory: WebAssembly.Memory | undefined
  const wasi = createPreview1({
    sys,
    args: boot.argv,
    env: Object.entries(boot.env).map(([key, value]) => `${key}=${value}`),
    preopens: [
      ['/', '/'],
      ['.', '.'],
    ],
    stdio: [0, 1, 2],
    ownsStdio: true,
    memory: () => memory!,
    exit: (code) => sys.exit(code),
  })

  const imports: WebAssembly.Imports = { wasi_snapshot_preview1: {} }
  for (const entry of WebAssembly.Module.imports(module)) {
    if (entry.kind !== 'function') continue
    const namespace = (imports[entry.module] ??= {}) as Record<string, unknown>
    namespace[entry.name] =
      entry.module === 'wasi_snapshot_preview1' && Object.hasOwn(wasi.imports, entry.name) ? wasi.imports[entry.name] : () => WASI_ENOSYS
  }

  const instance = new WebAssembly.Instance(module, imports)
  memory = instance.exports.memory as WebAssembly.Memory | undefined
  const start = instance.exports._start
  if (!memory || typeof start !== 'function') {
    sys.call('write', 2, encoder.encode(`${boot.argv[0]}: not a WASI command (missing memory or _start)\n`))
    return sys.exit(126)
  }

  try {
    ;(start as () => void)()
  } catch (error) {
    if (!(error instanceof WebAssembly.RuntimeError)) throw error
    sys.call('write', 2, encoder.encode(`${boot.argv[0]}: wasm trap: ${error.message}\n`))
    return sys.exit(134)
  }
  return sys.exit(0)
}
