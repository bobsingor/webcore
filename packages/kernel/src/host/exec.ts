// Host-side process orchestration: run a command or a pipeline and collect its output.
import { O_APPEND, O_CREAT, O_RDONLY, O_TRUNC, O_WRONLY } from '../abi/constants.ts'
import { Errno, KernelError } from '../abi/errno.ts'
import type { OpenFile } from '../kernel/files.ts'
import type { Kernel } from '../kernel/kernel.ts'
import { resolve } from '../kernel/path.ts'
import type { Process } from '../kernel/process.ts'

export interface Command {
  argv: string[]
  /** `< file` */
  stdin?: string
  /** `> file` or `>> file` */
  stdout?: { path: string; append: boolean }
}

export interface ExecOptions {
  cwd?: string
  env?: Record<string, string>
  /** Data fed to the first command's stdin. Without it, stdin is /dev/null. */
  stdin?: string | Uint8Array
  onStdout?(chunk: Uint8Array): void
  onStderr?(chunk: Uint8Array): void
  /** Aborting kills every process in the pipeline. */
  signal?: AbortSignal
}

export interface ExecResult {
  /** Exit code of the last command. */
  code: number
  codes: number[]
  stdout: string
  stderr: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Runs one command. */
export function exec(kernel: Kernel, argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return pipeline(kernel, [{ argv }], options)
}

/** Runs `a | b | c`. Resolves once every process has exited and all output is drained. */
export async function pipeline(kernel: Kernel, commands: Command[], options: ExecOptions = {}): Promise<ExecResult> {
  const cwd = options.cwd ?? '/'
  const held: OpenFile[] = []
  const hold = <T extends OpenFile>(file: T): T => {
    held.push(file)
    return file
  }
  const [stdoutRead, stdoutWrite] = kernel.pipe()
  const [stderrRead, stderrWrite] = kernel.pipe()
  hold(stdoutWrite)
  hold(stderrWrite)
  const report = (message: string) => void Promise.resolve(stderrWrite.write(encoder.encode(message))).catch(() => {})

  let stdin: OpenFile | undefined
  let feeding: Promise<unknown> = Promise.resolve()
  if (options.stdin !== undefined) {
    const [read, write] = kernel.pipe()
    stdin = hold(read)
    const data = typeof options.stdin === 'string' ? encoder.encode(options.stdin) : options.stdin
    feeding = Promise.resolve(write.write(data))
      .catch(() => {})
      .finally(() => write.release())
  }

  const procs: (Process | undefined)[] = []
  const failed: number[] = []
  commands.forEach((command, index) => {
    const last = index === commands.length - 1
    let input = stdin
    let output: OpenFile = stdoutWrite
    stdin = undefined
    try {
      if (command.stdin) input = hold(kernel.open(resolve(cwd, command.stdin), O_RDONLY))
      if (command.stdout) {
        const mode = command.stdout.append ? O_APPEND : O_TRUNC
        output = hold(kernel.open(resolve(cwd, command.stdout.path), O_WRONLY | O_CREAT | mode))
      } else if (!last) {
        const [read, write] = kernel.pipe()
        output = hold(write)
        stdin = hold(read)
      }
    } catch (error) {
      report(`sh: ${command.stdin ?? command.stdout?.path}: ${describe(error)}\n`)
      procs.push(undefined)
      failed[index] = 1
      return
    }
    try {
      procs.push(kernel.spawn(command.argv, { cwd, env: options.env, stdio: [input, output, stderrWrite] }))
    } catch (error) {
      const notFound = error instanceof KernelError && error.errno === Errno.ENOENT
      report(`sh: ${command.argv[0]}: ${notFound ? 'command not found' : describe(error)}\n`)
      procs.push(undefined)
      failed[index] = notFound ? 127 : 126
    }
  })
  // The children hold their own references; dropping ours lets EOF propagate.
  for (const file of held) file.release()

  options.signal?.addEventListener('abort', () => {
    for (const proc of procs) if (proc) kernel.kill(proc.pid, 2)
  })

  const [stdout, stderr, codes] = await Promise.all([
    drain(stdoutRead, options.onStdout),
    drain(stderrRead, options.onStderr),
    Promise.all(procs.map((proc, index) => proc?.exited ?? failed[index])),
  ])
  await feeding
  return { code: codes.at(-1) ?? 0, codes, stdout, stderr }
}

async function drain(file: OpenFile, onChunk?: (chunk: Uint8Array) => void): Promise<string> {
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const chunk = await file.read(64 * 1024)
      if (!chunk.length) break
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
  return decoder.decode(out)
}

function describe(error: unknown): string {
  if (!(error instanceof KernelError)) return error instanceof Error ? error.message : String(error)
  switch (error.errno) {
    case Errno.ENOENT:
      return 'No such file or directory'
    case Errno.EISDIR:
      return 'Is a directory'
    case Errno.ENOTDIR:
      return 'Not a directory'
    case Errno.EACCES:
      return 'Permission denied'
    case Errno.ENOEXEC:
      return 'cannot execute binary file: Exec format error'
    default:
      return error.message
  }
}
