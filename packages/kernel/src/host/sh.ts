// Shell sessions for hosts (the SDK's createShell, tests): each line runs in /bin/sh (BusyBox's
// hush) in the session's directory and environment. Afterwards the shell reports its working
// directory and exported variables on fd 3, and the next line starts from them.
import { SIGINT } from '../abi/signals.ts'
import type { OpenFile } from '../kernel/files.ts'
import type { Kernel } from '../kernel/kernel.ts'
import type { ExecOptions } from './exec.ts'

export interface Shell {
  cwd: string
  env: Record<string, string>
  status: number
}

export function createShell(init: Partial<Shell> = {}): Shell {
  return { cwd: init.cwd ?? '/', env: { ...init.env }, status: init.status ?? 0 }
}

// The line runs as the script itself (under eval, hush wouldn't track background jobs), and the
// shell reports its state as it exits, `exit` in the line included.
const REPORT = "trap '{ pwd; env -0; } >&3' EXIT\n"

/** Runs one line of shell input. Returns the exit status. */
export async function runLine(
  kernel: Kernel,
  shell: Shell,
  line: string,
  io: Pick<ExecOptions, 'onStdout' | 'onStderr' | 'signal'> = {},
): Promise<number> {
  const [stdoutRead, stdoutWrite] = kernel.pipe()
  const [stderrRead, stderrWrite] = kernel.pipe()
  const [stateRead, stateWrite] = kernel.pipe()
  let proc
  try {
    proc = kernel.spawn(['/bin/sh', '-c', REPORT + line], { cwd: shell.cwd, env: shell.env, stdio: [undefined, stdoutWrite, stderrWrite, stateWrite] })
  } finally {
    // The shell holds its own references; ours would keep the pipes from reaching EOF.
    for (const file of [stdoutWrite, stderrWrite, stateWrite]) file.release()
  }
  const interrupt = () => kernel.killGroup(proc.pgid, SIGINT)
  io.signal?.addEventListener('abort', interrupt, { once: true })
  try {
    const [, , state, code] = await Promise.all([drain(stdoutRead, io.onStdout), drain(stderrRead, io.onStderr), drain(stateRead), proc.exited])
    const text = new TextDecoder().decode(state)
    const newline = text.indexOf('\n')
    if (newline > 0) {
      shell.cwd = text.slice(0, newline)
      shell.env = Object.fromEntries(
        text
          .slice(newline + 1)
          .split('\0')
          .filter((entry) => entry.indexOf('=') > 0)
          .map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]),
      )
    }
    return (shell.status = code)
  } finally {
    io.signal?.removeEventListener('abort', interrupt)
  }
}

async function drain(file: OpenFile, onChunk?: (chunk: Uint8Array) => void): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  try {
    for (let chunk = await file.read(64 * 1024); chunk.length; chunk = await file.read(64 * 1024)) {
      chunks.push(chunk)
      onChunk?.(chunk)
    }
  } finally {
    file.release()
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
