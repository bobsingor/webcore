# 0016. Threads are Workers inside a process; worker_threads runs on host MessagePorts

- **Status:** Accepted · implemented in M1e
- **Date:** 2026-10-09

## Context

Vite 8 bundles with Rolldown. The build that runs in a browser is a wasm32-wasi N-API addon
(ADR-0006). Loading it needs `node:wasi`, an N-API runtime (emnapi, in JavaScript) and
`worker_threads`. Rolldown starts a pool of four threads over one shared `WebAssembly.Memory`.

ADR-0002 gives every process one Worker. It doesn't say what a thread is. These parts of
`worker_threads` constrain the design:
- Threads share the process: pid, file descriptors and working directory.
- Thread ids are process-wide and known synchronously, as soon as `new Worker()` returns.
- Messages are structured clones with transfer lists. MessagePorts can be sent anywhere, including
  to another thread.
- `'exit'` fires after every message the thread sent has been delivered.
- `terminate()` stops a thread even in a busy loop.

## Decision

**A thread is a Worker that belongs to a process.** `threadSpawn` starts a Worker with the
process's pid, fd table, working directory and personality, and its own syscall channel (a
shared-memory page and a port). `threadWait` joins a thread and `threadTerminate` stops it. The
host terminates the Worker, so a busy loop stops too. `exit` from a thread ends that thread. When
the process exits, all its threads end.

**`worker_threads` is Node's own `lib/` over two bindings:**
- **`messaging`:** Node's `MessagePort` and `MessageChannel` wrap host MessagePorts. A codec adds
  what the host's structured clone doesn't know:
  - Node's transfer-list rules and error messages
  - ports inside messages, which carry their undelivered messages with them
  - Node's cloneable and transferable classes, through its `kClone`/`kTransfer` protocol
  - `process.env`, which is a Proxy

  When both ends of a channel are in the same thread, a message goes straight into the other end's
  queue, so `receiveMessageOnPort()` sees it immediately, as in Node.
- **`worker`:** `new Worker()` takes its id from a counter in shared memory. The thread receives
  its end of the parent's port (the "env port") in its boot message.

**Exit ordering.** In Node, a cross-thread `postMessage` lands in the receiver's queue at once, so
everything a thread sent is waiting when its parent hears that it ended. Host channels give no
such guarantee, either between the kernel's report and the messages, or between two channels
(`parentPort` is a channel of its own). So:
- Every channel has an id, and each end counts the messages it has sent and received. The counts
  travel with a port when it is transferred.
- A thread's last message on the env port is an exit notice. It lists how many messages the thread
  sent on each channel it still has open.
- The parent emits `'exit'` once it has the kernel's report, the notice, and on its ends of those
  channels as many messages as the notice lists.

A terminated thread sends no notice. The parent then waits 20 ms for messages already in flight.

**Errors cross threads through V8's serializer.** Node serializes a thread's uncaught error with
`v8.serialize`. The `serdes` binding implements V8's ValueSerializer format (version 15) in
TypeScript, with Node's host-object hooks for typed arrays. For common values it writes the same
bytes as V8. The same binding makes `v8.serialize`/`deserialize` and `node:test` work.

## Consequences

- Rolldown's wasm build loads and runs its thread pool. Vite 8 starts in under a second in the
  browser.
- **No synchronous receive across threads.** A host MessagePort delivers only when its thread
  returns to the event loop. The `Atomics.wait` + `receiveMessageOnPort()` pattern (used by synckit,
  for example) works within a thread but not across threads.
- **Approximations:** `SHARE_ENV` copies the environment instead of sharing it. `resourceLimits`
  are reported but not enforced. Heap snapshots, CPU usage and profiling of threads are unavailable.
- A thread that exits doesn't yet end the threads it started, or close the files it opened.
- Each thread bootstraps Node again, which takes tens of milliseconds.

## Alternatives considered

- **Run a thread inside its parent's Worker**, as a separate realm. There is no parallelism, and
  `Atomics.wait` in the thread would block the parent. Wasm thread pools need real parallelism.
- **MessagePorts over shared-memory ring buffers.** These would allow synchronous receive across
  threads. But every message would need our own structured clone, and host objects such as
  `WebAssembly.Module` and shared memory can't cross as bytes. Host ports carry them natively. Rings
  could still be added later, for the synchronous case only.
- **Route messages through the kernel.** This adds a hop and a copy per message. The kernel
  doesn't need to see messages between threads.
