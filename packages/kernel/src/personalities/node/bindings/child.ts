// Child processes: spawn_sync (src/spawn_sync.cc). process_wrap follows with pipe_wrap.
import { SPAWN_SYNC_HEADER_BYTES } from '../../../abi/syscalls.ts'
import { CONSTANTS } from '../data/constants.ts'
import type { Realm } from '../realm.ts'
import { uvCode } from '../uv.ts'

interface StdioOption {
  type: 'pipe' | 'ignore' | 'inherit' | 'fd' | 'overlapped' | 'wrap'
  fd?: number
  input?: ArrayBufferView
}

interface SpawnSyncOptions {
  file: string
  args: string[]
  cwd?: string | null
  envPairs?: string[]
  stdio: StdioOption[]
  timeout?: number
  maxBuffer?: number
  killSignal?: number
}

const SIGNAL_NAMES = new Map(Object.entries(CONSTANTS.os.signals).map(([name, number]) => [number, name]))

export function signalName(signal: number | null): string | null {
  return signal === null ? null : (SIGNAL_NAMES.get(signal) ?? null)
}

export function envFromPairs(pairs: string[] | undefined): Record<string, string> | undefined {
  if (!pairs) return undefined
  const env: Record<string, string> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return env
}

export function childBindings() {
  return {
    spawn_sync: (realm: Realm) => ({
      spawn: (options: SpawnSyncOptions) => {
        const stdio = [0, 1, 2].map((fd): 'pipe' | 'ignore' | number => {
          const option = options.stdio[fd]
          if (!option || option.type === 'pipe' || option.type === 'overlapped') return 'pipe'
          if (option.type === 'ignore') return 'ignore'
          return option.fd ?? fd
        })
        const input = options.stdio[0]?.input
        const argv = [options.file, ...options.args.slice(1)]
        let packed: Uint8Array
        try {
          packed = realm.sys.call('spawnSync', argv, {
            cwd: options.cwd ?? undefined,
            env: envFromPairs(options.envPairs),
            stdio,
            input: input ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice() : undefined,
            timeout: options.timeout,
            killSignal: options.killSignal,
            maxBuffer: Number.isFinite(options.maxBuffer) ? options.maxBuffer : undefined,
          })
        } catch (error) {
          return { error: uvCode(error), status: null, signal: null, output: null, pid: 0 }
        }
        const [pid, status, signal, errno, stdoutLength, stderrLength] = new Int32Array(packed.buffer, packed.byteOffset, 6)
        const stdout = packed.subarray(SPAWN_SYNC_HEADER_BYTES, SPAWN_SYNC_HEADER_BYTES + stdoutLength)
        const stderr = packed.subarray(SPAWN_SYNC_HEADER_BYTES + stdoutLength, SPAWN_SYNC_HEADER_BYTES + stdoutLength + stderrLength)
        const captured = (fd: number, bytes: Uint8Array) => (stdio[fd] === 'pipe' ? realm.newBuffer(bytes.slice()) : null)
        const result: Record<string, unknown> = {
          pid,
          status: status === -1 ? null : status,
          signal: signal ? signalName(signal) : null,
          output: [null, captured(1, stdout), captured(2, stderr)],
        }
        if (errno && !pid) return { ...result, error: -errno, status: null, output: null }
        if (errno) result.error = -errno
        return result
      },
    }),
  }
}
