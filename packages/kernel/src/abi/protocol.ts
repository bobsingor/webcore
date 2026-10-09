import type { SyscallName, SyscallValue } from './syscalls.ts'

/** Process → kernel. `sync` requests are answered through the syscall page (ADR-0002). */
export interface SyscallRequest {
  t: 'sys'
  id: number
  name: SyscallName | 'exit'
  args: unknown[]
  sync: boolean
}

/** Kernel → process, for async requests only. */
export interface SyscallReply {
  t: 'ret'
  id: number
  errno: number
  value?: SyscallValue
}

export type Personality = 'wasi' | 'node'

/** First message a process Worker receives. */
export interface BootMessage {
  pid: number
  ppid: number
  argv: string[]
  env: Record<string, string>
  cwd: string
  execPath: string
  personality: Personality
  module?: WebAssembly.Module
  page: SharedArrayBuffer
  port: MessagePort
}
