// Node's libuv handle layer on kernel file descriptors: HandleWrap, LibuvStreamWrap
// (src/stream_base.cc), pipe_wrap, tty_wrap, tcp_wrap (virtual TCP, ADR-0014), process_wrap and
// cares_wrap (localhost only).
//
// Reads: readStart() pumps async read syscalls; each chunk is delivered as onread(arrayBuffer)
// with streamBaseState[kReadBytesOrError] set, and UV_EOF at the end. Writes complete
// asynchronously through req.oncomplete(status). An active, referenced handle keeps the loop alive.
import type { SocketAddress, SocketInfo } from '../../../abi/syscalls.ts'
import { familyOf, isLocalAddress } from '../../../kernel/net.ts'
import { bytesOf, encode } from '../codec.ts'
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
      }
    }

    private deliver(nread: number, chunk?: Uint8Array): void {
      const buffer = chunk && (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength ? chunk.buffer : chunk.slice().buffer)
      loop.callback(() => {
        streamBaseState[kReadBytesOrError] = nread
        streamBaseState[kArrayBufferOffset] = 0
        this.onread?.call(this, buffer as ArrayBuffer | undefined)
      })
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

  class TTY extends StreamHandle {
    constructor(fd: number) {
      super()
      this.fd = fd
    }
    getWindowSize(size: number[]): number {
      size[0] = 80
      size[1] = 24
      return 0
    }
    setRawMode(): number {
      return 0
    }
    setBlocking(): number {
      return 0
    }
  }

  class Process extends HandleWrap {
    pid = 0
    onexit?: (this: Process, exitCode: number, signalCode: string) => void

    spawn(file: string, args: string[], cwd: string | null | undefined, envPairs: string[] | undefined, stdio: StdioOption[]): number {
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
        })
      } catch (error) {
        for (const fd of [...childEnds, ...parentEnds]) sys.call('close', fd)
        if (!(error instanceof SysError)) throw error
        return uvCode(error)
      }
      // The child holds its own references; ours would keep its pipes from reaching EOF.
      for (const fd of childEnds) sys.call('close', fd)
      this.setActive(true)
      void sys.callAsync('waitStatus', this.pid).then(([code, signal]) => {
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

const streamsOf = (realm: Realm): Streams => (realm.streams ??= createStreams(realm))

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
      // No terminal device yet: everything is a pipe or file (PTY arrives in M2).
      isTTY: () => false,
      UV_TTY_MODE_NORMAL: 0,
      UV_TTY_MODE_RAW: 1,
      UV_TTY_MODE_IO: 2,
      UV_TTY_MODE_RAW_VT: 3,
    }),
    process_wrap: (realm: Realm) => ({
      Process: streamsOf(realm).Process,
      constants: { kProcessFlagDetached: 1, kProcessFlagWindowsHide: 2, kProcessFlagWindowsVerbatimArguments: 4 },
    }),
    // fs.watch arrives with kernel file events (M1e); watchers need the class to load.
    fs_event_wrap: (realm: Realm) => {
      class FSEvent extends streamsOf(realm).HandleWrap {
        initialized = false
        start() {
          return UV_ENOSYS
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
        convertIpv6StringToBuffer: () => null,
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
