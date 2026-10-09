# 0011. Kernel core is environment-agnostic (browser and headless)

- **Status:** Accepted · implemented in M0
- **Date:** 2026-10-09

## Context

The same sandbox is useful in several places:

- a browser tab (the main use)
- CI (to test the kernel itself)
- server-side agents (where a local in-process sandbox starts faster than a container)
- desktop apps

The only environment-specific things the kernel needs are a way to start a Worker and, later, storage
and networking backends.

## Decision

- The kernel core has no DOM or Node imports. It uses only ECMAScript, `WebAssembly`,
  `SharedArrayBuffer`/`Atomics`, `MessagePort` and `TextEncoder`/`TextDecoder`, which exist in browsers,
  Node, Deno and Bun.
- Environment specifics are injected through small host interfaces. In M0 that is `ProcessHost`,
  which starts a Worker. Storage and network host interfaces follow.
- Each environment has its own tiny process Worker entry (`worker.ts` for browsers, `worker-node.ts`
  for Node). Its only job is to receive the boot message and provide error hooks. After that, everything
  goes through the transferred `MessagePort`. Entries must not import anything else and must not use
  dynamic `import()`: code in the Worker shares globals with the guest program. M0 learned this the
  hard way when Vite's dev server injected its HMR client into every process, polluting stdout and
  keeping processes alive through its timers.
- The test suite runs end to end in Node, using `worker_threads` as the process host.

## Consequences

- CI exercises the real kernel, real Workers and real Wasm without a browser.
- A headless package (`@webcore/node`) becomes a thin wrapper, not a port.
- Browser-only behaviour (Service Worker preview, OPFS) still needs browser tests. Those run in the
  playground and, later, in Playwright.
