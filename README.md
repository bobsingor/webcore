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

## Status: M1a, real Node.js ✅

`node` is **Node.js v24.21.0**: Node's own JavaScript standard library, unmodified, running on the
browser's JavaScript engine over bindings written against the kernel. The bindings replace the C++
half of Node (ADR-0005, ADR-0012).

```sh
user@webcore:~$ node -p "process.version + ' on ' + process.platform"
v24.21.0 on linux
[exit 0 · 61 ms]
user@webcore:~$ node -e "const c = require('child_process').spawn('wc'); c.stdout.pipe(process.stdout); c.stdin.end('one two three\n')"
      1       3      14
```

What works:

- **Kernel:**
  - processes, fd tables, pipes with blocking reads, backpressure, EOF and EPIPE
  - an in-memory VFS, `spawn`/`wait`/`kill`, signals reported as signals
  - a kernel-side `spawnSync`
- **Syscall ABI:** Linux semantics and errno values. Sync calls block on a shared-memory page. Async
  calls go over a MessagePort, so Node's event loop keeps running.
- **Node.js:**
  - the real bootstrap and CommonJS loader, and libuv-style event-loop semantics
    (`nextTick` → microtasks → immediates → timers, `beforeExit`/`exit`)
  - `fs` (sync, callbacks, promises, streams), `Buffer`, `URL`, `stream`, `events`, `util`
  - `child_process` (`spawn` with stdio pipes, `execFile`, `spawnSync`, `kill`)
  - Node-formatted errors
  - 55 of 72 builtin modules load; the rest are scheduled (see [the M1 plan](docs/milestones/M1.md))
- **WASI preview1:** args, env, preopens, files, directories, pipes, clocks, random, sleeps.
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

`pnpm dev` builds the WASI test binaries and the Node standard library bundle first.

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
    src/personalities/   wasi.ts (WASI preview1), node/ (Node.js: realm, event loop, bindings)
    src/host/            ProcessHosts, exec/pipeline helpers, mini shell, root filesystem
    test/                unit + end-to-end tests
  node-lib/              Node v24.21.0's lib/, vendored, plus the bundle builder (ADR-0012)
  wat-bin/               hand-written WASI programs (echo, cat, wc, ls), no C toolchain needed
apps/
  playground/            browser demo (Vite)
```

## Embedding (current API)

```ts
import { Kernel, installRootfs, exec, DEFAULT_ENV } from '@webcore/kernel'
import { webProcessHost } from '@webcore/kernel/web' // or nodeProcessHost from '@webcore/kernel/node'

const kernel = new Kernel({ host: webProcessHost(), assets: { 'node-lib': nodeLibBytes } })
installRootfs(kernel, { echo: echoWasmBytes /* … */ })
kernel.events.subscribe((event) => console.log(event))

const { code, stdout } = await exec(kernel, ['node', '-p', '6 * 7'], { env: { ...DEFAULT_ENV } })
```

The page must be cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp`). See ADR-0002 and ADR-0009.

## Known limitations

- **No ES modules yet** (M1b) and **no networking yet**: `net`, `http`, DNS (M1c).
- **No `crypto` or `zlib` yet**, and **no package installer or `sh` process** (M1d).
- **No `fs.watch`, `worker_threads` or Wasm native addons** (M1e).
- **The kernel runs on the page's main thread.** It moves into an isolated iframe in M1e (ADR-0009).
- **The VFS is in-memory and mutable**, with no symlinks. The content-addressed copy-on-write store
  comes in M2 (ADR-0007).
- **No TTY/PTY yet**: stdio is pipes and files (M2).
- **The host-side shell is minimal.** A real bash/BusyBox via WASIX comes in M2.
- **WASI binaries are hand-written WAT.** Real wasi-sdk/WASIX builds arrive in M2.
