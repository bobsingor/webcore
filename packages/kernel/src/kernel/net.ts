// Virtual TCP (ADR-0014). There is one host, and every local address is an alias for it: a
// connection to 127.0.0.1, ::1 or localhost reaches whichever listener owns the port. Each
// connection is two pipes, one per direction, so reads block, writes apply backpressure and closing
// one end delivers EOF to the other.
import { kerr } from '../abi/errno.ts'
import { O_RDWR, S_IFSOCK } from '../abi/constants.ts'
import type { AddressFamily, SocketAddress } from '../abi/syscalls.ts'
import type { EventBus } from './events.ts'
import { OpenFile, pseudoStat } from './files.ts'
import { Pipe } from './pipe.ts'

// Linux's default ip_local_port_range.
const EPHEMERAL_FIRST = 32768
const EPHEMERAL_LAST = 60999

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function familyOf(address: string): AddressFamily | undefined {
  const octets = IPV4.exec(address)
  if (octets) return octets.slice(1).every((octet) => Number(octet) <= 255) ? 'IPv4' : undefined
  return address.includes(':') ? 'IPv6' : undefined
}

/** Loopback and wildcard addresses: the only ones that exist on the virtual host. */
export function isLocalAddress(address: string): boolean {
  const lower = address.toLowerCase()
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true
  if (lower === '::' || lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true
  const v4 = lower.startsWith('::ffff:') ? lower.slice(7) : lower
  return familyOf(v4) === 'IPv4' && (v4.startsWith('127.') || v4 === '0.0.0.0')
}

/** The address a connection to `address` appears to come from (and arrive at). */
function loopbackFor(address: string): SocketAddress['address'] {
  const lower = address.toLowerCase()
  if (lower === '::' || lower === 'localhost' || lower.endsWith('.localhost')) return lower === '::' ? '::1' : '127.0.0.1'
  if (lower === '0.0.0.0') return '127.0.0.1'
  return lower
}

function addr(address: string, port: number): SocketAddress {
  return { address, family: familyOf(address) ?? 'IPv4', port }
}

/** A connected endpoint. Reading takes the peer's writes; shutdown() sends EOF. */
export class Socket extends OpenFile {
  readonly type = 'socket'
  readonly local: SocketAddress
  readonly peer: SocketAddress
  private readonly incoming: Pipe
  private readonly outgoing: Pipe

  constructor(incoming: Pipe, outgoing: Pipe, local: SocketAddress, peer: SocketAddress) {
    super(O_RDWR)
    this.incoming = incoming
    this.outgoing = outgoing
    this.local = local
    this.peer = peer
  }

  override read(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.incoming.read(max, signal)
  }

  override write(data: Uint8Array, signal?: AbortSignal): Promise<number> {
    return this.outgoing.write(data, signal)
  }

  /** Closes the write direction (SHUT_WR): the peer reads EOF, and reading here continues. */
  shutdown(): void {
    this.outgoing.closeWrite()
  }

  stat() {
    return pseudoStat('socket', S_IFSOCK | 0o777, this.incoming.size)
  }

  protected override closed(): void {
    this.incoming.closeRead()
    this.outgoing.closeWrite()
  }
}

interface AcceptWaiter {
  resolve(socket: Socket): void
  reject(error: unknown): void
}

/** A listening socket: connections queue here until accepted. */
export class Listener extends OpenFile {
  readonly type = 'socket'
  readonly local: SocketAddress
  readonly pid: number
  private readonly network: Network
  private readonly queue: Socket[] = []
  private readonly waiters: AcceptWaiter[] = []
  private open = true

  constructor(network: Network, local: SocketAddress, pid: number) {
    super(O_RDWR)
    this.network = network
    this.local = local
    this.pid = pid
  }

  accept(signal?: AbortSignal): Promise<Socket> {
    if (!this.open) return Promise.reject(kerr('EBADF'))
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (signal?.aborted) return Promise.reject(kerr('EINTR'))
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(kerr('EINTR'))
      }
      const waiter: AcceptWaiter = {
        resolve: (socket) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(socket)
        },
        reject,
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  /** Hands a new connection's server end to the next accept(). */
  enqueue(socket: Socket): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve(socket)
    else this.queue.push(socket)
  }

  stat() {
    return pseudoStat('socket', S_IFSOCK | 0o777, 0)
  }

  protected override closed(): void {
    this.open = false
    this.network.unlisten(this)
    for (const waiter of this.waiters.splice(0)) waiter.reject(kerr('EBADF'))
    // Connections nobody accepted are dropped; their clients read EOF.
    for (const socket of this.queue.splice(0)) socket.release()
  }
}

export interface ListeningPort {
  port: number
  address: string
  family: AddressFamily
  pid: number
}

export class Network {
  private readonly events: EventBus
  private readonly listeners = new Map<number, Listener>()
  private nextEphemeral = EPHEMERAL_FIRST

  constructor(events: EventBus) {
    this.events = events
  }

  /** Ports with a listener, in the order they were opened. */
  get listening(): ListeningPort[] {
    return [...this.listeners.values()].map(({ local, pid }) => ({ ...local, pid }))
  }

  listen(address: string, port: number, pid: number): Listener {
    const family = familyOf(address)
    if (!family) throw kerr('EINVAL', address)
    if (!isLocalAddress(address)) throw kerr('EADDRNOTAVAIL', address)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw kerr('EINVAL', `port ${port}`)
    if (port === 0) port = this.ephemeralPort()
    else if (this.listeners.has(port)) throw kerr('EADDRINUSE', `${address}:${port}`)
    const listener = new Listener(this, { address, family, port }, pid)
    this.listeners.set(port, listener)
    this.events.emit({ type: 'net.listen', pid, port, address })
    return listener
  }

  /** Connects to `port`, returning the client end. The server end waits in the listener's queue. */
  connect(address: string, port: number): Socket {
    if (!isLocalAddress(address)) throw kerr('ENETUNREACH', address)
    const listener = this.listeners.get(port)
    if (!listener) throw kerr('ECONNREFUSED', `${address}:${port}`)

    const client = addr(loopbackFor(address), this.ephemeralPort())
    let server = addr(client.address, port)
    let peer = client
    // A dual-stack (IPv6) listener sees IPv4 clients as IPv4-mapped addresses, as on Linux.
    if (listener.local.family === 'IPv6' && client.family === 'IPv4') {
      server = { address: `::ffff:${server.address}`, family: 'IPv6', port }
      peer = { address: `::ffff:${client.address}`, family: 'IPv6', port: client.port }
    }
    const up = new Pipe()
    const down = new Pipe()
    listener.enqueue(new Socket(up, down, server, peer))
    return new Socket(down, up, client, addr(client.address, port))
  }

  unlisten(listener: Listener): void {
    if (this.listeners.get(listener.local.port) !== listener) return
    this.listeners.delete(listener.local.port)
    this.events.emit({ type: 'net.close', pid: listener.pid, port: listener.local.port })
  }

  private ephemeralPort(): number {
    for (let tries = 0; tries <= EPHEMERAL_LAST - EPHEMERAL_FIRST; tries++) {
      const port = this.nextEphemeral
      this.nextEphemeral = port === EPHEMERAL_LAST ? EPHEMERAL_FIRST : port + 1
      if (!this.listeners.has(port)) return port
    }
    throw kerr('EADDRINUSE', 'no free ephemeral ports')
  }
}
