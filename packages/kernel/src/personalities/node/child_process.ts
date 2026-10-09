// Node's `child_process` (M0: synchronous APIs only). Children are real kernel processes, so a
// Node script can spawn a WASI binary and read its output through a kernel pipe.
import { errnoName } from '../../abi/errno.ts'
import { SysError, type SyscallClient } from '../../process/syscalls.ts'
import { Buffer } from './buffer.ts'

type StdioMode = 'pipe' | 'inherit' | 'ignore' | number | null | undefined

export interface SpawnSyncOptions {
  cwd?: string
  env?: Record<string, string>
  input?: string | Uint8Array
  stdio?: StdioMode | StdioMode[]
  encoding?: string
}

export interface SpawnSyncResult {
  pid: number
  output: [null, Buffer | string | null, Buffer | string | null]
  stdout: Buffer | string | null
  stderr: Buffer | string | null
  status: number | null
  signal: null
  error?: Error
}

export function createChildProcess(sys: SyscallClient) {
  function readToEnd(fd: number): Buffer {
    const chunks: Uint8Array[] = []
    for (;;) {
      const chunk = sys.call('read', fd, sys.maxPayload)
      if (!chunk.length) break
      chunks.push(chunk)
    }
    sys.call('close', fd)
    return Buffer.concat(chunks)
  }

  function spawnSync(
    command: string,
    argsOrOptions?: readonly string[] | SpawnSyncOptions,
    maybeOptions?: SpawnSyncOptions,
  ): SpawnSyncResult {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : []
    const options = (Array.isArray(argsOrOptions) ? maybeOptions : (argsOrOptions as SpawnSyncOptions)) ?? {}
    const stdio = Array.isArray(options.stdio) ? options.stdio : [options.stdio, options.stdio, options.stdio]

    const childFds: [number, number, number] = [-1, -1, -1]
    const parentEnds: (number | undefined)[] = []
    const childEnds: number[] = []
    for (let i = 0; i < 3; i++) {
      const mode = stdio[i] ?? 'pipe'
      if (mode === 'inherit') childFds[i] = i
      else if (typeof mode === 'number') childFds[i] = mode
      else if (mode === 'pipe') {
        const [read, write] = sys.call('pipe')
        childFds[i] = i === 0 ? read : write
        parentEnds[i] = i === 0 ? write : read
        childEnds.push(childFds[i])
      }
    }

    let pid: number
    try {
      pid = sys.call('spawn', [command, ...args], { cwd: options.cwd, env: options.env, fds: childFds })
    } catch (error) {
      for (const fd of [...childEnds, ...parentEnds]) if (fd !== undefined) sys.call('close', fd)
      const code = error instanceof SysError ? errnoName(error.errno) : 'EIO'
      const spawnError = Object.assign(new Error(`spawnSync ${command} ${code}`), {
        code,
        errno: error instanceof SysError ? -error.errno : undefined,
        syscall: `spawnSync ${command}`,
        path: command,
        spawnargs: [...args],
      })
      return { pid: 0, output: [null, null, null], stdout: null, stderr: null, status: null, signal: null, error: spawnError }
    }

    // The child holds its own references now; close ours so EOF propagates.
    for (const fd of childEnds) sys.call('close', fd)

    if (parentEnds[0] !== undefined) {
      try {
        if (options.input !== undefined) {
          const input = typeof options.input === 'string' ? Buffer.from(options.input) : options.input
          sys.call('write', parentEnds[0], input)
        }
      } catch {
        // The child exited without reading its input (EPIPE).
      }
      sys.call('close', parentEnds[0])
    }

    // M0 limitation: stdout is drained before stderr. A child that writes more than a pipe's
    // capacity to stderr while stdout is still open will block until it exits.
    const stdout = parentEnds[1] !== undefined ? readToEnd(parentEnds[1]) : null
    const stderr = parentEnds[2] !== undefined ? readToEnd(parentEnds[2]) : null
    const status = sys.call('wait', pid)

    const decode = (data: Buffer | null) =>
      data && options.encoding && options.encoding !== 'buffer' ? data.toString(options.encoding) : data
    return {
      pid,
      output: [null, decode(stdout), decode(stderr)],
      stdout: decode(stdout),
      stderr: decode(stderr),
      status,
      signal: null,
    }
  }

  function execFileSync(file: string, args: readonly string[] = [], options: SpawnSyncOptions = {}) {
    const result = spawnSync(file, args, { ...options, stdio: options.stdio ?? ['pipe', 'pipe', 'inherit'] })
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw Object.assign(new Error(`Command failed: ${[file, ...args].join(' ')}`), {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      })
    }
    return result.stdout
  }

  const unsupported = (name: string) => () => {
    throw new Error(`child_process.${name} is not supported yet (webcore M0 supports spawnSync and execFileSync)`)
  }

  return {
    spawnSync,
    execFileSync,
    spawn: unsupported('spawn'),
    exec: unsupported('exec'),
    execSync: unsupported('execSync'),
    execFile: unsupported('execFile'),
    fork: unsupported('fork'),
  }
}
