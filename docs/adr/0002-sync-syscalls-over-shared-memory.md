# 0002. Synchronous syscalls over SharedArrayBuffer + Atomics, one Worker per process

- **Status:** Accepted · implemented in M0
- **Date:** 2026-10-09

## Context

C programs call `read()` and expect it to block. Node programs call `fs.readFileSync()` and expect
the same. Browsers have no blocking I/O on the main thread, and the kernel's own operations (waiting
for a pipe writer, fetching a lazy file) are inherently asynchronous.

The browser offers three ways to block a computation on async work:

| Mechanism | Availability | Cost |
|---|---|---|
| `Atomics.wait` in a Worker on a `SharedArrayBuffer` | All modern browsers with cross-origin isolation | Requires COOP/COEP headers |
| JSPI (JS Promise Integration) | Chromium; others in progress | Wasm only; not for plain JS |
| Asyncify (binary rewriting) | Everywhere | Larger, slower binaries; needs a rebuild |

## Decision

- Each process runs in its own Worker.
- Each process has a `SharedArrayBuffer` syscall page: a small `Int32Array` header (state, errno,
  return value, payload kind, payload length) followed by a data area.
- **Sync syscall:** the process posts `{name, args}` on its `MessagePort`, then calls
  `Atomics.wait(state, PENDING)`. The kernel computes the result asynchronously, writes it into the
  page, and calls `Atomics.notify`.
- **Async syscall:** the process posts `{id, name, args}` and the kernel replies with a message. The JS
  personality uses this for event-loop work such as `process.stdin.on('data')` and `fs.promises`.
- Both modes share a single dispatcher in the kernel. Only result delivery differs.
- `exit` never returns. The process blocks on its page until the kernel terminates the Worker.

JSPI is an optimization to add later for Wasm guests. It is not the baseline.

## Consequences

- The host page must be cross-origin isolated (COOP `same-origin` + COEP `require-corp` or
  `credentialless`). Every embedder inherits this constraint; see [0009](0009-origin-isolation.md).
- One Worker per process costs tens of milliseconds to start. A warm Worker pool is a planned
  optimization, and the design permits it.
- In M0, request arguments are structured-cloned through `postMessage`. A binary ring buffer in
  shared memory can replace this without changing the kernel's dispatcher.
- Payloads larger than the data area fail with `EOVERFLOW`. Readers request at most the area's size.

## Alternatives considered

- **Asyncify everywhere.** Works without COOP/COEP, but needs every binary rebuilt and can't help plain
  JavaScript.
- **Kernel inside each process.** No IPC cost, but no shared state, so no pipes between processes.
- **Synchronous XHR to a Service Worker.** A known hack for blocking without SharedArrayBuffer. Kept in
  reserve as a fallback for non-isolated embeddings.
