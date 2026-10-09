// The per-process syscall page (ADR-0002).
//
//   byte 0   i32 state   IDLE → PENDING (process) → DONE (kernel) → IDLE (process)
//   byte 4   i32 errno   0 on success
//   byte 8   i32 kind    none | number | bytes | json
//   byte 12  i32 length  payload length in bytes
//   byte 16  f64 number  numeric result
//   byte 28  i32 park    never written; `exit` parks on it until the Worker is terminated
//   byte 32  ...         payload area
import { Errno } from './errno.ts'
import type { SyscallValue } from './syscalls.ts'

export const HEADER_BYTES = 32
export const DEFAULT_PAGE_BYTES = 1 << 20

const STATE = 0
const ERRNO = 1
const KIND = 2
const LENGTH = 3
const PARK = 7
const NUMBER_OFFSET = 16

const IDLE = 0
const PENDING = 1
const DONE = 2

const KIND_NONE = 0
const KIND_NUMBER = 1
const KIND_BYTES = 2
const KIND_JSON = 3

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function createPage(payloadBytes = DEFAULT_PAGE_BYTES): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_BYTES + payloadBytes)
}

export function pageCapacity(page: SharedArrayBuffer): number {
  return page.byteLength - HEADER_BYTES
}

/** Kernel side: publish a result and wake the blocked process. */
export function completeSync(page: SharedArrayBuffer, errno: number, value: SyscallValue): void {
  const header = new Int32Array(page, 0, 8)
  let kind = KIND_NONE
  let length = 0
  if (!errno && value !== undefined) {
    if (typeof value === 'number') {
      new Float64Array(page, NUMBER_OFFSET, 1)[0] = value
      kind = KIND_NUMBER
    } else {
      const bytes = value instanceof Uint8Array ? value : encoder.encode(JSON.stringify(value))
      if (bytes.length > pageCapacity(page)) {
        errno = Errno.EOVERFLOW
      } else {
        new Uint8Array(page, HEADER_BYTES, bytes.length).set(bytes)
        kind = value instanceof Uint8Array ? KIND_BYTES : KIND_JSON
        length = bytes.length
      }
    }
  }
  header[ERRNO] = errno
  header[KIND] = errno ? KIND_NONE : kind
  header[LENGTH] = length
  Atomics.store(header, STATE, DONE)
  Atomics.notify(header, STATE)
}

/** Process side: mark the page busy. Must happen before the request is posted. */
export function beginSync(page: SharedArrayBuffer): void {
  Atomics.store(new Int32Array(page, 0, 8), STATE, PENDING)
}

/** Process side: block until the kernel completes the request. */
export function awaitSync(page: SharedArrayBuffer): { errno: number; value: SyscallValue } {
  const header = new Int32Array(page, 0, 8)
  while (Atomics.load(header, STATE) === PENDING) Atomics.wait(header, STATE, PENDING)
  const errno = header[ERRNO]
  const kind = header[KIND]
  const length = header[LENGTH]
  let value: SyscallValue
  if (kind === KIND_NUMBER) value = new Float64Array(page, NUMBER_OFFSET, 1)[0]
  // slice() copies out of shared memory; TextDecoder rejects shared views.
  else if (kind === KIND_BYTES) value = new Uint8Array(page, HEADER_BYTES, length).slice()
  else if (kind === KIND_JSON) value = JSON.parse(decoder.decode(new Uint8Array(page, HEADER_BYTES, length).slice()))
  Atomics.store(header, STATE, IDLE)
  return { errno, value }
}

/** Process side: block forever. Used after `exit`; the kernel terminates the Worker. */
export function park(page: SharedArrayBuffer): never {
  const header = new Int32Array(page, 0, 8)
  for (;;) Atomics.wait(header, PARK, 0)
}
