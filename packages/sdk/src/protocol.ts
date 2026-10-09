// The protocol between the host SDK (@webcore/sdk) and the runtime frame (@webcore/runtime)
// (ADR-0009, ADR-0017). Two window messages set up one MessagePort; everything else travels on it.
//
//   runtime → parent   { type: 'webcore:runtime-loaded' }       its listener is installed
//   parent → runtime   { type: 'webcore:runtime-hello' } + port  accepted once, from the parent only
//   runtime → port     { t: 'ready', info } or { t: 'failed', message }
//
// Calls are request/response by id. Output of jobs (processes and shell lines) streams separately,
// keyed by a job id the SDK chooses, so output can't arrive before its job is known.

export const PROTOCOL_VERSION = 1
export const RUNTIME_LOADED = 'webcore:runtime-loaded'
export const RUNTIME_HELLO = 'webcore:runtime-hello'

/** The page that installs a preview's Service Worker (ADR-0014). */
export const PREVIEW_BOOT_PATH = '/__webcore/boot.html'

export interface RuntimeInfo {
  protocol: number
  /** Preview origins, with `{port}` for the port: `http://p{port}.localhost:5190`. */
  previewOrigin: string
}

export type FileType = 'file' | 'dir' | 'chardev' | 'fifo' | 'socket' | 'symlink'

export interface DirEntry {
  name: string
  type: FileType
}

export interface FileStat {
  type: FileType
  size: number
  mode: number
  mtimeMs: number
}

export interface ShellState {
  cwd: string
  env: Record<string, string>
}

export type FsOp = 'create' | 'write' | 'unlink' | 'mkdir' | 'rmdir' | 'rename'

/** The kernel's structured events (ADR-0010). */
export type RuntimeEvent = (
  | { type: 'process.spawn'; pid: number; ppid: number; argv: string[]; cwd: string }
  | { type: 'process.exit'; pid: number; code: number }
  | { type: 'fs.change'; op: FsOp; path: string; to?: string }
  | { type: 'net.listen'; pid: number; port: number; address: string }
  | { type: 'net.close'; pid: number; port: number }
) & { seq: number; time: number }

export interface SpawnRequestOptions {
  cwd?: string
  env?: Record<string, string>
}

export interface TerminalRequestOptions extends SpawnRequestOptions {
  cols: number
  rows: number
}

/** Methods and their arguments and results. */
export interface Methods {
  'fs.readFile': [[path: string], Uint8Array]
  'fs.writeFile': [[path: string, data: Uint8Array | string], void]
  'fs.mkdir': [[path: string, recursive: boolean], void]
  'fs.readdir': [[path: string], DirEntry[]]
  'fs.stat': [[path: string], FileStat]
  'fs.rm': [[path: string, recursive: boolean, force: boolean], void]
  'fs.rename': [[from: string, to: string], void]
  /** Starts argv as job `job`; its output and exit follow as messages. */
  spawn: [[job: number, argv: string[], options: SpawnRequestOptions], { pid: number }]
  /**
   * Starts argv on a new pseudo-terminal as job `job`, leading a session with the terminal as its
   * controlling terminal. Output (fd 1) is what the terminal shows; stdin messages are keystrokes.
   */
  'terminal.open': [[job: number, argv: string[], options: TerminalRequestOptions], { pid: number }]
  'shell.create': [[init: Partial<ShellState>], { session: number } & ShellState]
  /** Runs a line in a session as job `job`; resolves when it's done. */
  'shell.run': [[job: number, session: number, line: string], { code: number } & ShellState]
  /** Turns forwarding of kernel events on or off. */
  events: [[enabled: boolean], void]
}

export type Method = keyof Methods

export type HostMessage =
  | { [M in Method]: { t: 'call'; id: number; method: M; args: Methods[M][0] } }[Method]
  /** Data for a spawned job's stdin, or keystrokes for a terminal; null closes it (a terminal hangs up). */
  | { t: 'stdin'; job: number; data: Uint8Array | null }
  /** A terminal's new size: the foreground job gets SIGWINCH. */
  | { t: 'resize'; job: number; cols: number; rows: number }
  /** Signals a job: its process, or with `group`, every process it started (Ctrl+C). */
  | { t: 'signal'; job: number; signal: number; group: boolean }
  /** A preview page's channel to the bridge, relayed by the SDK; the port is transferred. */
  | { t: 'preview'; origin: string }

export interface RemoteError {
  message: string
  /** An errno name such as ENOENT, for filesystem and process errors. */
  code?: string
}

export type RuntimeMessage =
  | { t: 'ready'; info: RuntimeInfo }
  | { t: 'failed'; message: string }
  | { t: 'result'; id: number; value: unknown }
  | { t: 'error'; id: number; error: RemoteError }
  | { t: 'events'; events: RuntimeEvent[] }
  | { t: 'output'; job: number; fd: 1 | 2; data: Uint8Array }
  | { t: 'exit'; job: number; code: number }

/** The parts of a MessagePort both sides use (browser and Node ports both fit). */
export interface PortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  start(): void
  close(): void
}

/** The origin that previews `port`, from RuntimeInfo.previewOrigin. */
export function previewOrigin(template: string, port: number): string {
  return template.replace('{port}', String(port))
}

/** The port an origin previews, if it is one of the runtime's preview origins. */
export function previewPortOf(template: string, origin: string): number | undefined {
  let hostname: string
  try {
    hostname = new URL(origin).hostname
  } catch {
    return undefined
  }
  const match = /^p(\d{1,5})(?:[.-]|$)/.exec(hostname)
  const port = match ? Number(match[1]) : NaN
  if (!(port > 0 && port < 65536)) return undefined
  return previewOrigin(template, port) === origin ? port : undefined
}
