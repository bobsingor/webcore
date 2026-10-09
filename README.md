# webcore

> **Working name.** "webcore" collides with WebKit's WebCore and will change before anything is
> published.

An open-source operating-system kernel for the browser, for running complete development
environments client-side: Node.js, Python, shells, databases and dev servers. Like StackBlitz
WebContainers, but open, multi-language from the kernel up, and designed to be driven by AI agents.

The core idea: **the kernel and its syscall ABI are the product; languages and databases are just
executables.** Every command is a real process in its own Worker. All processes share one kernel:
processes, file descriptors, pipes, a filesystem, and (soon) virtual sockets. JavaScript runs on the
browser's own JIT. Everything else runs as WebAssembly.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design and roadmap, and
[docs/adr/](docs/adr/README.md) for the decisions behind it.

## Status: M0 kernel spike ✅

M0 proves the riskiest part of the design. A JavaScript process and a WASI binary pipe into each other
through **synchronous syscalls** (SharedArrayBuffer + Atomics), in the browser and headless in Node:

```sh
user@webcore:~$ echo hello webcore | node -e "process.stdin.on('data', d => process.stdout.write(d.toString().toUpperCase()))" | wc
      1       2      14
[exit 0 · 25 ms]
```

Three processes and two personalities run in that example: `echo` and `wc` are WASI binaries, and
`node` runs JavaScript on the host engine. They are connected by kernel pipes and the whole pipeline
finishes in about 25 ms in a production build.

What works:

- **Kernel:** process table, per-process fd tables, shared open-file descriptions, pipes with blocking
  reads, backpressure, EOF and EPIPE, an in-memory VFS, `spawn`/`wait`, zombies and reaping, kill.
- **Syscall ABI:** Linux semantics and errno values. Sync calls block on a per-process
  SharedArrayBuffer page. Async calls go over a MessagePort, so the JS event loop keeps running.
- **WASI preview1 personality:** args, env, preopens, files, directories (`fd_readdir`), pipes, clocks,
  random, `poll_oneoff` sleeps.
- **Node personality (small M0 shim):**
  - `process`, stdin/stdout/stderr, `fs` (sync, promises, callbacks)
  - `path`, `events`, `util`, `os`, `url`, `assert`, `Buffer`
  - `child_process.spawnSync`, CommonJS `require` with `node_modules`
  - timers, and Node's event-loop exit semantics
- **Structured events:** spawn, exit and fs changes (ADR-0010).
- **Hosts:** browser (`@webcore/kernel/web`) and headless Node (`@webcore/kernel/node`).

## Quick start

Requires Node ≥ 22.6 and pnpm.

```bash
pnpm install
```

```bash
pnpm dev
```

`pnpm dev` opens the playground at http://localhost:5180: a terminal, example commands, and a live
kernel event log.

```bash
pnpm test
```

`pnpm test` runs end to end in Node with real Workers and real Wasm.

```bash
pnpm typecheck
```

## Repository layout

```
docs/
  ARCHITECTURE.md        vision, components, languages/databases matrix, roadmap
  adr/                   architecture decision records
packages/
  kernel/                @webcore/kernel
    src/abi/             syscall surface, errno, flags, wire protocol, syscall page
    src/kernel/          Kernel, processes, VFS, pipes, open files, exec resolution, events
    src/process/         Worker entries (browser, Node) and the process-side syscall client
    src/personalities/   wasi.ts (WASI preview1), node/ (M0 Node shim)
    src/host/            ProcessHosts, exec/pipeline helpers, mini shell, root filesystem
    test/                unit + end-to-end tests
  wat-bin/               hand-written WASI programs (echo, cat, wc, ls), no C toolchain needed
apps/
  playground/            browser demo (Vite)
```

## Embedding (current API)

```ts
import { Kernel, installRootfs, exec, DEFAULT_ENV } from '@webcore/kernel'
import { webProcessHost } from '@webcore/kernel/web' // or nodeProcessHost from '@webcore/kernel/node'

const kernel = new Kernel({ host: webProcessHost() })
installRootfs(kernel, { echo: echoWasmBytes /* … */ })
kernel.events.subscribe((event) => console.log(event))

const { code, stdout } = await exec(kernel, ['node', '-p', '6 * 7'], { env: { ...DEFAULT_ENV } })
```

The page must be cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp`). See ADR-0002 and ADR-0009.

## Deliberate M0 limitations

- **The Node shim is throwaway.** It supports CommonJS only, with no ESM, `net`/`http`, async
  `child_process` or general streams. M1 replaces it with Node's own `lib/` over kernel-implemented
  bindings (ADR-0005).
- **No sockets, TTY/PTY or signals yet** (apart from kill). These come in M1 and M2.
- **The kernel runs on the page's main thread.** It moves into an isolated iframe in M1 (ADR-0009).
- **The VFS is in-memory and mutable.** The content-addressed copy-on-write store with snapshots comes
  in M2 (ADR-0007).
- **The shell runs on the host side** and is minimal. A real bash/BusyBox via WASIX comes in M2.
- **WASI binaries are hand-written WAT.** Real wasi-sdk/WASIX builds arrive in M2.
