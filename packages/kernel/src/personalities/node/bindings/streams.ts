// Node's libuv handle layer on kernel file descriptors: HandleWrap, LibuvStreamWrap
// (src/stream_base.cc), pipe_wrap, tty_wrap, tcp_wrap (virtual TCP, ADR-0014), process_wrap and
// cares_wrap (localhost only).
//
// Reads: readStart() pumps async read syscalls; each chunk is delivered as onread(arrayBuffer)
// with streamBaseState[kReadBytesOrError] set, and UV_EOF at the end. Writes complete
// asynchronously through req.oncomplete(status). An active, referenced handle keeps the loop alive.
import {
  CS8,
  ECHO,
  ECHONL,
  ICANON,
  ICRNL,
  IEXTEN,
  IGNCR,
  INLCR,
  ISIG,
  ISTRIP,
  IXON,
  ONLCR,
  OPOST,
  TCGETS,
  TCSETSW,
  TIOCGWINSZ,
  VMIN,
  VTIME,
  type Termios,
  type WinSize,
} from '../../../abi/signals.ts'
import type { SocketAddress, SocketInfo } from '../../../abi/syscalls.ts'
import { familyOf, isLocalAddress } from '../../../kernel/net.ts'
import { bytesOf, encode } from '../codec.ts'
import { host } from '../host.ts'
import type { Realm } from '../realm.ts'
import { SysError } from '../../../process/syscalls.ts'
import { uvCode } from '../uv.ts'
import { envFromPairs, signalName } from './child.ts'

const kReadBytesOrError = 0
const kArrayBufferOffset = 1
const kBytesWritten = 2
const kLastWriteWasAsync = 3
const UV_EOF = -4095
const UV_EBADF = -9
const UV_EINVAL = -22
const UV_ENOSYS = -38
const UV_ENOTCONN = -107
const UV_EAI_NONAME = -3008
const READ_CHUNK = 64 * 1024
const DNS_ORDER_IPV6_FIRST = 2
const kProcessFlagDetached = 1
const UV_TTY_MODE_NORMAL = 0
const UV_TTY_MODE_RAW = 1
const UV_TTY_MODE_IO = 2
// termios bits libuv changes (asm-generic/termbits.h)
const IGNBRK = 0o1
const BRKINT = 0o2
const PARMRK = 0o10
const INPCK = 0o20
const CSIZE = 0o60
const PARENB = 0o400

/** isatty(): whether `fd` is a terminal (TCGETS succeeds). */
export function isTerminal(realm: Realm, fd: number): boolean {
  try {
    realm.sys.call('ioctl', fd, TCGETS)
    return true
  } catch {
    return false
  }
}

type Request = { oncomplete?: (...args: unknown[]) => void; handle?: unknown }

export interface StdioOption {
  type: 'pipe' | 'overlapped' | 'ignore' | 'inherit' | 'fd' | 'wrap' | 'ipc'
  fd?: number
  handle?: { fd: number }
}

export function createStreams(realm: Realm) {
  const { sys, loop } = realm
  const streamBaseState = new Int32Array(5)

  class HandleWrap {
    protected refed = true
    protected active = false
    closed = false

    ref(): void {
      if (this.refed) return
      this.refed = true
      if (this.active) loop.ref()
    }

    unref(): void {
      if (!this.refed) return
      this.refed = false
      if (this.active) loop.unref()
    }

    hasRef(): boolean {
      return this.refed
    }

    getAsyncId(): number {
      return -1
    }

    getProviderType(): number {
      return 0
    }

    close(callback?: () => void): void {
      if (this.closed) return
      this.closed = true
      this.setActive(false)
      this.onClose()
      if (typeof callback === 'function') loop.macrotask(() => callback.call(this))
    }

    protected onClose(): void {}

    protected setActive(active: boolean): void {
      if (active === this.active) return
      this.active = active
      if (!this.refed) return
      if (active) loop.ref()
      else loop.unref()
    }
  }

  class StreamHandle extends HandleWrap {
    fd = -1
    reading = false
    bytesRead = 0
    bytesWritten = 0
    writeQueueSize = 0
    readonly isStreamBase = true
    onread?: (this: StreamHandle, arrayBuffer?: ArrayBuffer) => unknown
    private wantRead = false
    private pumping = false
    private pendingWrites = 0
    private shut = false
    private fdReleased = false

    readStart(): number {
      if (this.fd < 0) return UV_EBADF
      this.wantRead = true
      this.updateActive()
      void this.pump()
      return 0
    }

    readStop(): number {
      this.wantRead = false
      this.updateActive()
      return 0
    }

    useUserBuffer(): void {}

    writeBuffer(req: Request, buffer: ArrayBufferView): number {
      return this.write(req, bytesOf(buffer).slice())
    }

    writeUtf8String(req: Request, text: string): number {
      return this.write(req, encode(text, 'utf8'))
    }

    writeAsciiString(req: Request, text: string): number {
      return this.write(req, encode(text, 'latin1'))
    }

    writeLatin1String(req: Request, text: string): number {
      return this.write(req, encode(text, 'latin1'))
    }

    writeUcs2String(req: Request, text: string): number {
      return this.write(req, encode(text, 'utf16le'))
    }

    writev(req: Request, chunks: unknown[], allBuffers: boolean): number {
      const parts: Uint8Array[] = []
      if (allBuffers) for (const chunk of chunks) parts.push(bytesOf(chunk as ArrayBufferView))
      else {
        for (let i = 0; i < chunks.length; i += 2) {
          const chunk = chunks[i]
          parts.push(typeof chunk === 'string' ? encode(chunk, chunks[i + 1]) : bytesOf(chunk as ArrayBufferView))
        }
      }
      const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
      let offset = 0
      for (const part of parts) {
        data.set(part, offset)
        offset += part.length
      }
      return this.write(req, data)
    }

    /** Closes the write direction once queued writes have finished, then completes `req`. */
    shutdown(req: Request): number {
      if (this.fd < 0) return UV_EBADF
      const finish = () => {
        this.shut = true
        let status = 0
        try {
          if (this.fd >= 0) this.shutdownWrite()
        } catch (error) {
          status = uvCode(error)
        }
        loop.callback(() => req.oncomplete?.call(req, status, this))
      }
      const wait = () => (this.pendingWrites > 0 ? loop.defer(wait) : finish())
      loop.defer(wait)
      return 0
    }

    /** Sends EOF. A pipe has no half-close, so this closes our end; sockets override it. */
    protected shutdownWrite(): void {
      sys.call('close', this.fd)
      this.fdReleased = true
    }

    protected override onClose(): void {
      this.wantRead = false
      this.settleDrained()
      if (this.fd >= 0 && !this.fdReleased) {
        try {
          sys.call('close', this.fd)
        } catch {
          // Already closed by the kernel (e.g. the process is exiting).
        }
      }
      this.fd = -1
    }

    private write(req: Request, data: Uint8Array): number {
      if (this.fd < 0 || this.shut) return UV_EBADF
      streamBaseState[kBytesWritten] = data.length
      if (this.blocking) return this.writeNow(data)
      streamBaseState[kLastWriteWasAsync] = 1
      this.pendingWrites++
      this.updateActive()
      sys
        .callAsync('write', this.fd, data)
        .then(
          () => 0,
          (error) => uvCode(error),
        )
        .then((status) => {
          this.pendingWrites--
          if (status === 0) this.bytesWritten += data.length
          this.updateActive()
          loop.callback(() => req.oncomplete?.call(req, status, this, undefined))
        })
      return 0
    }

    private async pump(): Promise<void> {
      if (this.pumping) return
      this.pumping = true
      try {
        while (this.wantRead && this.fd >= 0) {
          let chunk: Uint8Array
          try {
            chunk = await sys.callAsync('read', this.fd, READ_CHUNK)
          } catch (error) {
            if (this.fd >= 0) this.deliver(uvCode(error))
            break
          }
          if (this.fd < 0) break
          if (!chunk.length) {
            this.wantRead = false
            this.deliver(UV_EOF)
            break
          }
          this.bytesRead += chunk.length
          this.deliver(chunk.length, chunk)
        }
      } finally {
        this.pumping = false
        this.updateActive()
        if (!this.wantRead || this.fd < 0) this.settleDrained()
      }
    }

    private drainedWaiters: (() => void)[] = []

    /**
     * Resolves once reading has reached the end (or nobody reads, or `limit` ms passed). A child's
     * exit waits for this on its stdio pipes: in Node, libuv delivers a child's last output before
     * its exit in practice, and programs rely on that.
     */
    drained(limit: number): Promise<void> {
      if (!this.wantRead || this.fd < 0) return Promise.resolve()
      return new Promise((resolve) => {
        const timer = host.setTimeout(resolve, limit)
        this.drainedWaiters.push(() => {
          host.clearTimeout(timer)
          resolve()
        })
      })
    }

    private settleDrained(): void {
      for (const resolve of this.drainedWaiters.splice(0)) resolve()
    }

    private deliver(nread: number, chunk?: Uint8Array): void {
      const buffer = chunk && (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength ? chunk.buffer : chunk.slice().buffer)
      loop.callback(() => {
        streamBaseState[kReadBytesOrError] = nread
        streamBaseState[kArrayBufferOffset] = 0
        this.onread?.call(this, buffer as ArrayBuffer | undefined)
      })
    }

    /** Blocking handles (TTYs after setBlocking(true), as libuv makes them) write synchronously. */
    protected blocking = false

    private writeNow(data: Uint8Array): number {
      streamBaseState[kLastWriteWasAsync] = 0
      try {
        for (let offset = 0; offset < data.length; offset += sys.maxPayload) {
          sys.call('write', this.fd, data.subarray(offset, offset + sys.maxPayload))
        }
      } catch (error) {
        return uvCode(error)
      }
      this.bytesWritten += data.length
      return 0
    }

    /** Whether pending work keeps the handle active (and the loop alive while referenced). */
    protected busy(): boolean {
      return this.wantRead || this.pendingWrites > 0
    }

    protected updateActive(): void {
      this.setActive(!this.closed && this.busy())
    }
  }

  class Pipe extends StreamHandle {
    readonly type: number
    constructor(type = 0) {
      super()
      this.type = type
    }
    open(fd: number): number {
      this.fd = fd
      return 0
    }
    // Unix-domain sockets arrive with networking (M1c).
    bind(): number {
      return UV_ENOSYS
    }
    listen(): number {
      return UV_ENOSYS
    }
    connect(): number {
      return UV_ENOSYS
    }
    fchmod(): number {
      return 0
    }
    setPendingInstances(): void {}
  }

  class TCP extends StreamHandle {
    readonly type: number
    onconnection?: (this: TCP, status: number, client?: TCP) => void
    private bound?: { address: string; port: number }
    private local?: SocketAddress
    private peer?: SocketAddress
    private listening = false
    private connecting = false

    constructor(type = 0) {
      super()
      this.type = type
    }

    open(fd: number): number {
      this.fd = fd
      return 0
    }

    // Binding only records the address: like libuv, errors such as EADDRINUSE surface at listen().
    bind(address: string, port: number): number {
      return this.recordBind(address, port)
    }

    bind6(address: string, port: number): number {
      return this.recordBind(address, port)
    }

    listen(_backlog: number): number {
      const { address, port } = this.bound ?? { address: '0.0.0.0', port: 0 }
      try {
        const [fd, actual] = sys.call('listen', address, port)
        this.fd = fd
        this.local = { address, family: familyOf(address) ?? 'IPv4', port: actual }
      } catch (error) {
        if (!(error instanceof SysError)) throw error
        return uvCode(error)
      }
      this.listening = true
      this.updateActive()
      void this.acceptLoop()
      return 0
    }

    connect(req: Request, address: string, port: number): number {
      return this.startConnect(req, address, port)
    }

    connect6(req: Request, address: string, port: number): number {
      return this.startConnect(req, address, port)
    }

    getsockname(out: Record<string, unknown>): number {
      const local = this.local ?? (this.bound && { ...this.bound, family: familyOf(this.bound.address) ?? 'IPv4' })
      if (!local) return UV_EINVAL
      Object.assign(out, local)
      return 0
    }

    getpeername(out: Record<string, unknown>): number {
      if (!this.peer) return UV_ENOTCONN
      Object.assign(out, this.peer)
      return 0
    }

    setNoDelay(): number {
      return 0
    }

    setKeepAlive(): number {
      return 0
    }

    setSimultaneousAccepts(): void {}

    /** An abortive close (RST). The peer sees the connection end. */
    reset(callback?: () => void): number {
      this.close(callback)
      return 0
    }

    /** Wraps a connection accepted by a listener. */
    adopt(info: SocketInfo): this {
      this.fd = info.fd
      this.local = info.local
      this.peer = info.peer
      return this
    }

    protected override shutdownWrite(): void {
      sys.call('shutdown', this.fd)
    }

    protected override busy(): boolean {
      return super.busy() || this.listening || this.connecting
    }

    protected override onClose(): void {
      this.listening = false
      super.onClose()
    }

    private recordBind(address: string, port: number): number {
      if (!familyOf(address)) return UV_EINVAL
      this.bound = { address, port }
      return 0
    }

    private startConnect(req: Request, address: string, port: number): number {
      let status = 0
      try {
        this.adopt(sys.call('connect', address, port))
      } catch (error) {
        if (!(error instanceof SysError)) throw error
        status = uvCode(error)
      }
      // Connection results are always asynchronous, even an immediate ECONNREFUSED.
      this.connecting = true
      this.updateActive()
      loop.defer(() => {
        this.connecting = false
        this.updateActive()
        if (this.closed) return
        loop.callback(() => req.oncomplete?.call(req, status, this, req, true, true))
      })
      return 0
    }

    private async acceptLoop(): Promise<void> {
      while (!this.closed) {
        let info: SocketInfo
        try {
          info = await sys.callAsync('accept', this.fd)
        } catch (error) {
          if (!this.closed) loop.callback(() => this.onconnection?.call(this, uvCode(error)))
          return
        }
        if (this.closed) {
          try {
            sys.call('close', info.fd)
          } catch {
            // The process is exiting.
          }
          return
        }
        const client = new TCP(0).adopt(info)
        loop.callback(() => this.onconnection?.call(this, 0, client))
      }
    }
  }

  // libuv's terminal modes. The first switch away from normal mode saves the terminal's settings;
  // normal mode, and the process's exit (uv_tty_reset_mode), restore them.
  let savedTermios: { fd: number; termios: Termios } | undefined
  const setTtyMode = (fd: number, mode: number): number => {
    try {
      const current = sys.call('ioctl', fd, TCGETS) as Termios
      if (mode === UV_TTY_MODE_NORMAL) {
        if (savedTermios?.fd === fd) sys.call('ioctl', fd, TCSETSW, savedTermios.termios)
        return 0
      }
      if (!savedTermios) {
        savedTermios = { fd, termios: current }
        realm.atExit.add(() => {
          try {
            sys.call('ioctl', fd, TCSETSW, savedTermios!.termios)
          } catch {
            // The terminal is gone.
          }
        })
      }
      const base = savedTermios.fd === fd ? savedTermios.termios : current
      const next: Termios = { ...base, cc: [...base.cc] }
      if (mode === UV_TTY_MODE_IO) {
        // cfmakeraw()
        next.iflag &= ~(IGNBRK | BRKINT | PARMRK | ISTRIP | INLCR | IGNCR | ICRNL | IXON)
        next.oflag &= ~OPOST
        next.lflag &= ~(ECHO | ECHONL | ICANON | ISIG | IEXTEN)
        next.cflag = (next.cflag & ~(CSIZE | PARENB)) | CS8
      } else {
        next.iflag &= ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON)
        next.oflag |= ONLCR
        next.cflag |= CS8
        next.lflag &= ~(ECHO | ICANON | IEXTEN | ISIG)
      }
      next.cc[VMIN] = 1
      next.cc[VTIME] = 0
      sys.call('ioctl', fd, TCSETSW, next)
      return 0
    } catch (error) {
      return uvCode(error)
    }
  }

  /** A terminal fd (tty_wrap): the kernel's PTY slave, as stdin, stdout or stderr. */
  class TTY extends StreamHandle {
    constructor(fd: number, ctx?: { code?: string; errno?: number; syscall?: string }) {
      super()
      this.fd = fd
      try {
        sys.call('ioctl', fd, TCGETS)
      } catch (error) {
        if (ctx) Object.assign(ctx, { errno: uvCode(error), code: (error as SysError).code ?? 'EINVAL', syscall: 'uv_tty_init' })
      }
    }

    getWindowSize(size: number[]): number {
      try {
        const { cols, rows } = sys.call('ioctl', this.fd, TIOCGWINSZ) as WinSize
        size[0] = cols
        size[1] = rows
        return 0
      } catch (error) {
        return uvCode(error)
      }
    }

    setRawMode(flag: boolean | number): number {
      // Node passes a mode (UV_TTY_MODE_*) or, from older call sites, a boolean.
      const mode = typeof flag === 'number' ? flag : flag ? UV_TTY_MODE_RAW : UV_TTY_MODE_NORMAL
      return setTtyMode(this.fd, mode)
    }

    setBlocking(flag: boolean): number {
      this.blocking = Boolean(flag)
      return 0
    }
  }

  class Process extends HandleWrap {
    pid = 0
    onexit?: (this: Process, exitCode: number, signalCode: string) => void

    spawn(
      file: string,
      args: string[],
      cwd: string | null | undefined,
      envPairs: string[] | undefined,
      stdio: StdioOption[],
      flags = 0,
    ): number {
      // execFile defaults cwd to null, meaning "inherit".
      const options = { file, args, cwd: cwd ?? undefined, envPairs, stdio }
      const fds: [number, number, number] = [-1, -1, -1]
      const childEnds: number[] = []
      const parentEnds: number[] = []
      try {
        for (let i = 0; i < 3; i++) {
          const option = options.stdio[i]
          if (!option || option.type === 'ignore') continue
          if (option.type === 'pipe' || option.type === 'overlapped') {
            const [read, write] = sys.call('pipe')
            const [child, parent] = i === 0 ? [read, write] : [write, read]
            fds[i] = child
            childEnds.push(child)
            parentEnds.push(parent)
            if (option.handle) option.handle.fd = parent
          } else if (option.type === 'wrap') {
            fds[i] = option.handle?.fd ?? -1
          } else {
            fds[i] = option.fd ?? i
          }
        }
        this.pid = sys.call('spawn', [options.file, ...options.args.slice(1)], {
          cwd: options.cwd,
          env: envFromPairs(options.envPairs),
          fds,
          detached: (flags & kProcessFlagDetached) !== 0,
        })
      } catch (error) {
        for (const fd of [...childEnds, ...parentEnds]) sys.call('close', fd)
        if (!(error instanceof SysError)) throw error
        return uvCode(error)
      }
      // The child holds its own references; ours would keep its pipes from reaching EOF.
      for (const fd of childEnds) sys.call('close', fd)
      this.setActive(true)
      const outputs = options.stdio
        .slice(1)
        .filter((option) => option?.type === 'pipe' || option?.type === 'overlapped')
        .map((option) => option!.handle as unknown as StreamHandle | undefined)
      void sys.callAsync('waitStatus', this.pid).then(async ([code, signal]) => {
        // The child's last output first, then its exit.
        await Promise.all(outputs.map((handle) => handle?.drained?.(50)))
        this.setActive(false)
        loop.callback(() => this.onexit?.call(this, code ?? 0, signalName(signal) ?? ''))
      })
      return 0
    }

    kill(signal: number): number {
      try {
        sys.call('kill', this.pid, signal)
        return 0
      } catch (error) {
        return uvCode(error)
      }
    }
  }

  return { streamBaseState, HandleWrap, StreamHandle, Pipe, TCP, TTY, Process }
}

export type Streams = ReturnType<typeof createStreams>

/** An IPv6 address as 16 bytes (uv_inet_pton), or undefined if it isn't one. */
function ipv6Bytes(address: string): Uint8Array | undefined {
  let text = address.split('%')[0]
  const bytes = new Uint8Array(16)
  // An embedded IPv4 address (::ffff:1.2.3.4) is the last two groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (v4) {
    const octets = v4.slice(1).map(Number)
    if (octets.some((octet) => octet > 255)) return undefined
    text = `${text.slice(0, v4.index)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const groups = (part: string) => (part ? part.split(':') : [])
  const head = groups(halves[0])
  const tail = halves.length === 2 ? groups(halves[1]) : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  for (const [i, group] of all.entries()) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined
    const value = Number.parseInt(group, 16)
    bytes[i * 2] = value >> 8
    bytes[i * 2 + 1] = value & 0xff
  }
  return bytes
}

export const streamsOf = (realm: Realm): Streams => (realm.streams ??= createStreams(realm))

export function streamBindings() {
  return {
    stream_wrap: (realm: Realm) => {
      const { streamBaseState, StreamHandle } = streamsOf(realm)
      return {
        LibuvStreamWrap: StreamHandle,
        ShutdownWrap: class ShutdownWrap {},
        WriteWrap: class WriteWrap {},
        streamBaseState,
        kReadBytesOrError,
        kArrayBufferOffset,
        kBytesWritten,
        kLastWriteWasAsync,
      }
    },
    pipe_wrap: (realm: Realm) => ({
      Pipe: streamsOf(realm).Pipe,
      PipeConnectWrap: class PipeConnectWrap {},
      constants: { SOCKET: 0, SERVER: 1, IPC: 2, UV_READABLE: 1, UV_WRITABLE: 2 },
    }),
    tcp_wrap: (realm: Realm) => ({
      TCP: streamsOf(realm).TCP,
      TCPConnectWrap: class TCPConnectWrap {},
      constants: { SOCKET: 0, SERVER: 1, UV_TCP_IPV6ONLY: 1 },
    }),
    tty_wrap: (realm: Realm) => ({
      TTY: streamsOf(realm).TTY,
      isTTY: (fd: number) => isTerminal(realm, fd),
      UV_TTY_MODE_NORMAL,
      UV_TTY_MODE_RAW,
      UV_TTY_MODE_IO,
      UV_TTY_MODE_RAW_VT: 3,
    }),
    process_wrap: (realm: Realm) => ({
      Process: streamsOf(realm).Process,
      constants: { kProcessFlagDetached: 1, kProcessFlagWindowsHide: 2, kProcessFlagWindowsVerbatimArguments: 4 },
    }),
    // fs.watch over the kernel's watch fds (like inotify): one async read per batch of changes.
    fs_event_wrap: (realm: Realm) => {
      const { sys, loop } = realm
      const decoder = new host.TextDecoder()
      class FSEvent extends streamsOf(realm).HandleWrap {
        onchange?: (status: number, eventType: string, filename: unknown) => void
        #fd = -1

        get initialized() {
          return this.#fd >= 0
        }

        start(filename: string, persistent: boolean, recursive: boolean, encoding?: string) {
          try {
            this.#fd = sys.call('watch', filename, Boolean(recursive))
          } catch (error) {
            if (!(error instanceof SysError)) throw error
            return uvCode(error)
          }
          if (!persistent) this.unref()
          this.setActive(true)
          void this.pump(encoding)
          return 0
        }

        protected override onClose(): void {
          const fd = this.#fd
          this.#fd = -1
          if (fd >= 0) {
            try {
              sys.call('close', fd)
            } catch {
              // The process is exiting.
            }
          }
        }

        private async pump(encoding?: string): Promise<void> {
          while (this.#fd >= 0) {
            let chunk: Uint8Array
            try {
              chunk = await sys.callAsync('read', this.#fd, READ_CHUNK)
            } catch {
              return
            }
            if (!chunk.length || this.#fd < 0) return
            for (const line of decoder.decode(chunk).split('\n')) {
              if (!line) continue
              const { event, path } = JSON.parse(line) as { event: string; path: string }
              const name = encoding === 'buffer' ? realm.newBuffer(encode(path, 'utf8')) : path
              loop.callback(() => this.onchange?.call(this, 0, event, name))
            }
          }
        }
      }
      return { FSEvent }
    },
    // UDP arrives with networking (M1c); dgram needs these to load.
    udp_wrap: (realm: Realm) => {
      class UDP extends streamsOf(realm).HandleWrap {
        open() {
          return UV_ENOSYS
        }
        bind() {
          return UV_ENOSYS
        }
        bind6() {
          return UV_ENOSYS
        }
        send() {
          return UV_ENOSYS
        }
        send6() {
          return UV_ENOSYS
        }
        recvStart() {
          return UV_ENOSYS
        }
        recvStop() {
          return 0
        }
      }
      return { UDP, SendWrap: class SendWrap {}, constants: { UV_UDP_IPV6ONLY: 1, UV_UDP_REUSEPORT: 8 } }
    },
    // Name resolution: only the virtual host exists (localhost and *.localhost, ADR-0014). IP
    // literals never get here; dns.lookup() answers those itself.
    cares_wrap: (realm: Realm) => {
      const { loop } = realm
      const LOCAL_NAMES = new Set(['localhost', 'webcore'])
      const isLocalName = (name: string) => {
        const lower = name.toLowerCase().replace(/\.$/, '')
        return LOCAL_NAMES.has(lower) || lower.endsWith('.localhost')
      }
      const complete = (req: { oncomplete?: (...args: unknown[]) => void }, ...args: unknown[]) => {
        loop.requestStarted()
        loop.defer(() => {
          loop.requestFinished()
          loop.callback(() => req.oncomplete?.call(req, ...args))
        })
        return 0
      }
      class ChannelWrap {
        getServers() {
          return []
        }
        setServers() {
          return 0
        }
        setLocalAddress() {}
        cancel() {}
      }
      return {
        GetAddrInfoReqWrap: class GetAddrInfoReqWrap {},
        GetNameInfoReqWrap: class GetNameInfoReqWrap {},
        QueryReqWrap: class QueryReqWrap {},
        ChannelWrap,
        getaddrinfo: (req: object, hostname: string, family: number, _hints: number, order: number) => {
          if (!isLocalName(hostname)) return complete(req, UV_EAI_NONAME, null)
          const v4 = family === 6 ? [] : ['127.0.0.1']
          const v6 = family === 4 ? [] : ['::1']
          return complete(req, 0, order === DNS_ORDER_IPV6_FIRST ? [...v6, ...v4] : [...v4, ...v6])
        },
        getnameinfo: (req: object, host: string, port: number) =>
          isLocalAddress(host) ? complete(req, 0, 'localhost', String(port)) : complete(req, UV_EAI_NONAME),
        canonicalizeIP: (ip: string) => (familyOf(ip) ? ip.toLowerCase() : undefined),
        convertIpv6StringToBuffer: (address: string) => {
          const bytes = ipv6Bytes(address)
          return bytes ? realm.newBuffer(bytes) : null
        },
        strerror: (code: number) => (code === UV_EAI_NONAME ? 'unknown node or service' : `DNS error ${code}`),
        AI_ADDRCONFIG: 1024,
        AI_ALL: 256,
        AI_V4MAPPED: 2048,
        DNS_ORDER_VERBATIM: 0,
        DNS_ORDER_IPV4_FIRST: 1,
        DNS_ORDER_IPV6_FIRST,
      }
    },
  }
}
