// Node's libuv handle layer on kernel file descriptors: HandleWrap, LibuvStreamWrap
// (src/stream_base.cc), pipe_wrap, tty_wrap, tcp_wrap (a shell until M1c), process_wrap and a
// minimal cares_wrap.
//
// Reads: readStart() pumps async read syscalls; each chunk is delivered as onread(arrayBuffer)
// with streamBaseState[kReadBytesOrError] set, and UV_EOF at the end. Writes complete
// asynchronously through req.oncomplete(status). An active, referenced handle keeps the loop alive.
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
const UV_ENOSYS = -38
const READ_CHUNK = 64 * 1024

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
        const fd = this.fd
        this.shut = true
        let status = 0
        try {
          if (fd >= 0) sys.call('close', fd)
        } catch (error) {
          status = uvCode(error)
        }
        loop.callback(() => req.oncomplete?.call(req, status, this))
      }
      const wait = () => (this.pendingWrites > 0 ? loop.defer(wait) : finish())
      loop.defer(wait)
      return 0
    }

    protected override onClose(): void {
      this.wantRead = false
      if (this.fd >= 0 && !this.shut) {
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

    private updateActive(): void {
      this.setActive(!this.closed && (this.wantRead || this.pendingWrites > 0))
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
    constructor(type = 0) {
      super()
      this.type = type
    }
    open(fd: number): number {
      this.fd = fd
      return 0
    }
    // Virtual TCP arrives with networking (M1c).
    bind(): number {
      return UV_ENOSYS
    }
    bind6(): number {
      return UV_ENOSYS
    }
    listen(): number {
      return UV_ENOSYS
    }
    connect(): number {
      return UV_ENOSYS
    }
    connect6(): number {
      return UV_ENOSYS
    }
    getsockname(): number {
      return UV_ENOSYS
    }
    getpeername(): number {
      return UV_ENOSYS
    }
    setNoDelay(): number {
      return 0
    }
    setKeepAlive(): number {
      return 0
    }
    reset(): number {
      return 0
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
    // DNS arrives with networking (M1c); net needs these classes to load.
    cares_wrap: () => ({
      GetAddrInfoReqWrap: class GetAddrInfoReqWrap {},
      GetNameInfoReqWrap: class GetNameInfoReqWrap {},
      QueryReqWrap: class QueryReqWrap {},
      ChannelWrap: class ChannelWrap {
        getServers() {
          return []
        }
        setServers() {
          return 0
        }
        setLocalAddress() {}
        cancel() {}
      },
      getaddrinfo: () => UV_ENOSYS,
      getnameinfo: () => UV_ENOSYS,
      canonicalizeIP: (ip: string) => ip,
      convertIpv6StringToBuffer: () => null,
      strerror: (code: number) => `DNS error ${code}`,
      AI_ADDRCONFIG: 1024,
      AI_ALL: 256,
      AI_V4MAPPED: 2048,
      DNS_ORDER_VERBATIM: 0,
      DNS_ORDER_IPV4_FIRST: 1,
      DNS_ORDER_IPV6_FIRST: 2,
    }),
  }
}
