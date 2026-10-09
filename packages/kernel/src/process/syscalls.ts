import { Errno, errnoMessage, errnoName } from '../abi/errno.ts'
import { awaitSync, beginSync, pageCapacity, park } from '../abi/page.ts'
import type { SyscallReply, SyscallRequest } from '../abi/protocol.ts'
import type { SignalMessage } from '../abi/signals.ts'
import type { SyscallArgs, SyscallName, SyscallReturn } from '../abi/syscalls.ts'

/** A failed syscall, as seen inside a process. `errno` uses Linux numbering. */
export class SysError extends Error {
  readonly errno: number
  readonly code: string

  constructor(errno: number, syscall: string) {
    super(`${errnoName(errno)}: ${errnoMessage(errno)}, ${syscall}`)
    this.errno = errno
    this.code = errnoName(errno)
  }
}

interface Pending {
  resolve(value: unknown): void
  reject(error: unknown): void
}

/**
 * The process end of the syscall channel (ADR-0002). `call` blocks the Worker on the syscall page;
 * `callAsync` goes over the MessagePort and leaves the event loop running.
 */
export class SyscallClient {
  /** Largest payload a single sync result can carry (bounds `read`). */
  readonly maxPayload: number
  /** Receives the signals this process handles (see the sigaction syscall). */
  onSignal?: (signal: number) => void
  /**
   * Runs a WASI process's signal handlers when a signal whose handler restarts syscalls
   * (SA_RESTART) interrupted a call; the call is then made again.
   */
  onRestart?: () => void
  private readonly port: MessagePort
  private readonly page: SharedArrayBuffer
  private readonly pending = new Map<number, Pending>()
  private nextId = 1

  constructor(port: MessagePort, page: SharedArrayBuffer) {
    this.port = port
    this.page = page
    this.maxPayload = pageCapacity(page)
    port.addEventListener('message', (event) => this.onMessage(event.data))
    port.start()
  }

  call<N extends SyscallName>(name: N, ...args: SyscallArgs<N>): SyscallReturn<N> {
    for (;;) {
      beginSync(this.page)
      this.post({ t: 'sys', id: 0, name, args, sync: true })
      const { errno, value } = awaitSync(this.page)
      if (errno === Errno.ERESTARTSYS && this.onRestart) {
        this.onRestart()
        continue
      }
      if (errno) throw new SysError(errno, name)
      return value as SyscallReturn<N>
    }
  }

  callAsync<N extends SyscallName>(name: N, ...args: SyscallArgs<N>): Promise<SyscallReturn<N>> {
    return this.callAsyncTransfer(name, args, [])
  }

  /** callAsync whose arguments include transferables (MessagePorts). */
  callAsyncTransfer<N extends SyscallName>(name: N, args: SyscallArgs<N>, transfer: Transferable[]): Promise<SyscallReturn<N>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.post({ t: 'sys', id, name, args, sync: false }, transfer)
    })
  }

  /** Never returns: the kernel tears down the process and terminates this Worker. */
  exit(code: number): never {
    beginSync(this.page)
    this.post({ t: 'sys', id: 0, name: 'exit', args: [code], sync: true })
    return park(this.page)
  }

  private post(request: SyscallRequest, transfer: Transferable[] = []): void {
    this.port.postMessage(request, transfer)
  }

  private onMessage(reply: SyscallReply | SignalMessage): void {
    if (reply?.t === 'sig') {
      this.onSignal?.(reply.signal)
      return
    }
    if (reply?.t !== 'ret') return
    const pending = this.pending.get(reply.id)
    if (!pending) return
    this.pending.delete(reply.id)
    if (reply.errno) pending.reject(new SysError(reply.errno, 'async'))
    else pending.resolve(reply.value)
  }
}
