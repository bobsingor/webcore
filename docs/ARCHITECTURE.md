# Architecture

> Working name: **webcore**. This name collides with WebKit's WebCore and must change before
> anything is published. See [Open questions](#open-questions).

## Goal

An open-source operating-system kernel for the browser. It runs complete development environments:
Node.js, Python, PHP, shells, databases and dev servers. Everything runs client-side, it can be
embedded in any web app, and it is built so that AI agents can drive it.

**Think big in interfaces, build small in implementation.** The kernel's contracts (syscall ABI,
filesystem, networking, events, snapshots) are designed for many languages and databases from day
one. The implementation ships one vertical slice at a time.

### Non-goals (for now)

- Video/tutorial generation. It is a downstream consumer of the [event log](#event-log) and
  [snapshots](#filesystem-and-snapshots), and it will live in a separate package.
- Running unmodified x86/ARM Linux binaries. A CPU-emulation backend is an optional escape hatch for
  later, not the core.
- Production hosting. This is a development and sandbox runtime.

## Landscape (October 2026)

| Project | What it is | Licence | Notes |
|---|---|---|---|
| StackBlitz WebContainers | Node.js in the browser | Proprietary | Commercial licence required for production use |
| BrowserPod 2.0 (Leaning Technologies) | Linux-syscall-compatible Wasm sandbox; Node.js, bash, git, BusyBox; Python/Ruby/Go/Rust on roadmap | Commercial (free for non-commercial use) | Closest to this design |
| Wasmer SDK | WASIX runtime; Python, PHP, Next.js in browser; Node via Edge.js | MIT | JS appears to run in an engine inside Wasm, not on the host's JIT |
| WebVM / CheerpX | x86 emulation of a Debian image | CheerpX proprietary | Maximum compatibility, slow, heavy |
| WordPress Playground, Pyodide, PGlite, JupyterLite | Single-runtime Wasm ports | Various open source | Excellent building blocks |

**Where this project fits:** an open, embeddable kernel where JavaScript runs on the browser's own JIT,
other languages run as Wasm processes on the same kernel, and agents get a first-class structured API.

## Overview

```
 Host app (IDE, AI app-builder, docs page)
   │  SDK / MCP: exec · fs · ports · snapshot · events
   ▼  postMessage (runtime lives on its own isolated origin)
 ┌─ Kernel ──────────────────────────────────────────────────┐
 │ processes · VFS (copy-on-write, content-addressed)         │
 │ pipes/PTY · virtual TCP/UDP · signals · event log          │
 └──────── syscall ABI (SharedArrayBuffer + Atomics) ─────────┘
   JS personality         WASI/WASIX personality   Emscripten adapter
   node on host engine    bash, git, coreutils,    Pyodide, PGlite,
   + Node's own lib/*.js  CPython, PHP, Go, Rust   php-wasm, DuckDB

 Service Worker: preview URL ──► kernel socket :5173
 Mounts: memfs · OPFS · lazy-HTTP (runtimes) · overlay
```

## Components

### Kernel ([ADR-0001](adr/0001-kernel-is-the-product.md))

The kernel owns all shared state: the process table, per-process file-descriptor tables, open file
descriptions, pipes, the VFS, the virtual network and the event log. It never blocks. Every syscall is
an async operation that completes later, so a pipe read can wait for a writer without freezing
anything.

The kernel is plain TypeScript with no DOM dependencies. It runs on a page, in a worker, or in
Node/Bun/Deno ([ADR-0011](adr/0011-environment-agnostic-core.md)).

### Processes and the syscall ABI ([ADR-0002](adr/0002-sync-syscalls-over-shared-memory.md), [ADR-0003](adr/0003-linux-semantics-and-numbering.md))

Each process runs in its own Worker. A process makes a syscall by posting a request to the kernel and
then blocking on `Atomics.wait` over a per-process `SharedArrayBuffer`. The kernel writes the result
into that buffer and calls `Atomics.notify`. This gives C programs and `fs.readFileSync` the blocking
semantics they expect.

JavaScript code can also make *async* syscalls (post a message, receive a message) so that event-loop
work such as `process.stdin.on('data')` never blocks the thread.

Syscall semantics, flags and errno values follow Linux. Personalities translate them into what their
guests expect: WASI errno numbers, Node error codes, and so on.

### Personalities

A personality adapts a kind of executable to the kernel ABI. The kernel decides which one to use from
the file's header.

| Personality | Detects | Runs | ADR |
|---|---|---|---|
| WASI / WASIX | `\0asm` magic | Any binary built for `wasm32-wasi(p1)`; WASIX extensions add fork/exec, sockets, signals, threads | [0004](adr/0004-wasi-and-wasix-abi.md) |
| JS (Node) | `#!personality:node` | JavaScript on the host JIT, with Node's built-in modules implemented over kernel syscalls | [0005](adr/0005-js-on-the-host-engine.md) |
| Emscripten adapter | Emscripten glue + wasm | Pyodide, PGlite, php-wasm, existing ports, with their FS/syscall layer redirected to the kernel | [0004](adr/0004-wasi-and-wasix-abi.md) |
| VM (later, optional) | ELF magic | Unmodified binaries through a CPU emulator (v86-style). Slow, but an escape hatch for the long tail | — |

Scripts with a generic `#!/path/to/interpreter` line are re-executed through that interpreter, as on
Linux.

### Filesystem and snapshots ([ADR-0007](adr/0007-content-addressed-cow-vfs.md))

The VFS is a mount table over pluggable backends:

- **memfs**: fast, volatile. Used for `node_modules` and `/tmp`.
- **OPFS**: persistent project storage.
- **lazy-HTTP**: read-only, fetched on demand. Used for large runtime images such as the Python stdlib.
- **overlay**: a copy-on-write layer over any of the above.

File contents are content-addressed (hash → blob). A **snapshot** is a small manifest of tree hashes,
which makes snapshot, restore, fork and dedupe cheap. This also enables "open this moment of the
tutorial in the IDE" without any extra mechanism.

### Networking ([ADR-0008](adr/0008-virtual-networking.md))

- **Virtual sockets** inside the kernel. A dev server calling `listen(5173)` or PGlite listening on
  `5432` is just a kernel socket, and unmodified drivers (`pg`, `mysql2`, `redis`) connect to them.
- **Preview:** a Service Worker on the preview origin turns browser HTTP requests into connections on
  the matching kernel socket.
- **Outbound:** HTTP(S) goes through `fetch`, so it is subject to CORS. A small, self-hostable
  WebSocket→TCP relay is optional and enables `git`, `ssh` and remote databases.

### Isolation model ([ADR-0009](adr/0009-origin-isolation.md))

The runtime runs in a cross-origin iframe on its own domain. Each preview gets its own subdomain. Code
inside the sandbox, including AI-generated code, never shares an origin with the embedding app's
cookies or tokens. Cross-origin isolation (COOP/COEP) is required for `SharedArrayBuffer`, and the
embedding story is designed around that.

### Event log ([ADR-0010](adr/0010-structured-event-log.md))

Every observable kernel action emits a structured, serializable event: process spawn and exit,
filesystem mutations, port open and close, network requests, and (opt-in) syscall traces. Consumers
include:

- **Agents** get structured observations instead of scraping a terminal.
- **Replay and time travel**: event log plus snapshots.
- **Tutorial studio** (later): turns a recorded session into an editable presentation.

### Native addons ([ADR-0006](adr/0006-native-addons.md))

Modern JS toolchains ship Rust/C++ binaries (Rolldown, esbuild, lightningcss, Tailwind's oxide). The
JS personality supports N-API for Wasm builds of those addons (`wasm32-wasip1-threads`, emnapi). The
package installer also keeps a substitution table for packages that only ship native binaries, for
example `esbuild` → `esbuild-wasm`.

### Host SDK and agent API

A typed API that embedders and agents use:

```ts
const os = await boot({ /* mounts, origin, relay */ })
await os.fs.writeFile('/app/index.js', src)
const run = os.exec('npm', ['run', 'dev'])          // streams stdout/stderr
const port = await os.ports.waitFor(5173)           // → preview URL
const snap = await os.snapshot()                    // → content hash
os.events.subscribe(e => …)                         // structured event stream
```

The same surface is exposed as an MCP server.

## Languages and databases

"Supporting a language" in a dev environment means running its **toolchain**, not just its output.
Interpreted languages are much easier than compiled ones.

| Target | Route | Notes |
|---|---|---|
| Node.js | JS personality | Most of the total effort; measured against Node's own test suite |
| Python | CPython WASI/WASIX build, or Pyodide via Emscripten adapter | Pyodide brings numpy/pandas wheels |
| PHP, Ruby | php-wasm, ruby.wasm | WordPress Playground is the reference implementation |
| Go | Go toolchain built for `wasip1` | Compiler in the browser is feasible |
| Rust, C/C++ | Run WASI output; toolchains (rustc, clang) are very large | Later; possibly lazy-loaded |
| SQLite | Wasm build; backs `node:sqlite`, with substitution for `better-sqlite3` | Easiest early win |
| PostgreSQL | PGlite on a virtual `:5432` speaking the wire protocol | Single connection, fine for development |
| DuckDB | duckdb-wasm | Analytics |
| MySQL, MongoDB, Redis | Later: compatible servers, or relay to remote | Not promised early |

## Roadmap

Each milestone has a concrete exit criterion.

| # | Milestone | Exit criterion |
|---|---|---|
| **M0** | **Kernel spike** ✅ | A JS process and a WASI binary pipe into each other through synchronous syscalls, in the browser and headless in Node |
| **M1** | **Flagship** ✅ ([plan](milestones/M1.md)) | `npm create vite` → `npm install` → `npm run dev` with a live preview |
| **M2** | **Shell and state** (now, [plan](milestones/M2.md)) | bash/BusyBox via WASIX, PTY + xterm.js, CoW VFS with snapshot/restore |
| M3 | Second runtime | Python + PGlite on the same kernel (forces the kernel to stay language-neutral) |
| M4 | Agents | Host SDK + MCP server, headless package, public compatibility dashboard |
| M5 | Studio | Tutorial/replay layer as a separate package consuming events and snapshots |

### M0 scope (the spike)

Proves the riskiest part of the design, the syscall transport shared by different personalities:

- [x] Kernel with process table, fd tables, pipes (blocking reads, bounded writes, EOF/EPIPE), and a memfs VFS
- [x] Sync syscalls over `SharedArrayBuffer` + `Atomics`; async syscalls over `MessagePort`
- [x] WASI preview1 personality (args, env, preopens, files, dirs, pipes, clocks, random)
- [x] Minimal Node personality (process, stdin/stdout, fs, path, events, child_process.spawnSync, require)
- [x] `spawn`/`wait` as syscalls, so processes create processes
- [x] Structured events (spawn, exit, fs changes)
- [x] Runs in the browser (playground) and headless in Node (test suite)

The Node personality in M0 is a deliberately small hand-written shim. It is replaced in M1 by Node's
own `lib/` running over kernel-implemented `internalBinding`s ([ADR-0005](adr/0005-js-on-the-host-engine.md)).

### What M0 taught us

- **The transport holds up.** A 3-process WASI → JS → WASI pipeline finishes in about 25 ms in a
  production build. A single short-lived process takes 12–20 ms, which is mostly Worker startup. A
  **warm Worker pool** is therefore an early M1 task: `npm run` scripts spawn many short processes.
- **Anything in a process Worker shares globals with the guest.** Vite's dev server injected its HMR
  client into every process (triggered by a dynamic `import()` in the Worker entry). The client wrote
  `[vite] connected.` to the guest's stdout and kept processes alive through its timers. Worker
  entries are now per-environment and pristine, with a regression test
  ([ADR-0011](adr/0011-environment-agnostic-core.md)). The same rule will matter for Node's real
  `lib/`: guest-visible globals must be installed deliberately, never leaked from the host.
- **Pipes carry bytes, not messages.** A flaky test came from a program that wrote one line in
  several syscalls. That is correct kernel behaviour. Tests and tools must never assume chunk
  boundaries.
- **Headless works for CI.** The same kernel, Workers and Wasm run under Node's `worker_threads`.
  Node 22.6–22.17 needs `--experimental-strip-types` for the TypeScript Worker entry; the Node host
  adds the flag automatically.

## Open questions

- **Name.** "webcore" collides with WebKit's WebCore. Pick a new name before publishing.
- **Licence.** Recommend Apache-2.0 (patent grant) or MIT. The kernel must be freely embeddable,
  because AI app-builders are the main adopters.
- **Business model.** Open-core like EmbedPDF. The parts that genuinely need servers are natural hosted
  products: package CDN/cache, CORS and TCP relay, preview domains, snapshot storage.
- **WASIX governance.** Depending on a single vendor's ABI extensions is a risk. Track WASI 0.3 and
  keep the kernel ABI our own, with WASIX as an adapter.
- **Browser support.** Chromium first. Track JSPI availability in Safari and Firefox as an alternative
  to SharedArrayBuffer-based blocking.
