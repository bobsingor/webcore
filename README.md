# webcore

> **Working name.** "webcore" collides with WebKit's WebCore and will change before anything is
> published.

An open-source operating-system kernel for the browser, for running complete development
environments client-side: Node.js, Python, shells, databases and dev servers. Like StackBlitz
WebContainers, but open, multi-language from the kernel up, and designed to be driven by AI agents.

The core idea: **the kernel and its syscall ABI are the product; languages and databases are just
executables.** Every command is a real process in its own Worker. All processes share one kernel:
processes, file descriptors, pipes, a filesystem, and virtual sockets. JavaScript runs on the
browser's own JIT. Everything else runs as WebAssembly.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design and roadmap, and
[docs/adr/](docs/adr/README.md) for the decisions behind it.

## Status: M1e, Vite ✅

`node` is **Node.js v24.21.0**: Node's own JavaScript standard library, unmodified, running on the
browser's JavaScript engine over bindings written against the kernel. The bindings replace the C++
half of Node (ADR-0005, ADR-0012). Servers it starts open in a preview pane (ADR-0014), and
`npm create vite` + `npm install` work against the real npm registry (ADR-0015).

M1's exit criterion runs in the browser: `npm run dev` starts Vite 8 (with Rolldown's wasm build and
its worker threads) in under a second, the React app renders in the preview pane, and edits update
it in place (HMR).

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
  - virtual TCP on one loopback host: `listen`/`accept`/`connect`/`shutdown` (ADR-0014)
  - symbolic and hard links, process groups (Ctrl+C stops a whole job), and `extract`, which
    unpacks an npm tarball in one syscall (ADR-0015)
  - threads: Workers inside a process, sharing its fds (ADR-0016)
  - `watch`, an inotify-like fd fed by the kernel's filesystem events
- **Syscall ABI:** Linux semantics and errno values. Sync calls block on a shared-memory page. Async
  calls go over a MessagePort, so Node's event loop keeps running.
- **Node.js:**
  - the real bootstrap and CommonJS loader, and libuv-style event-loop semantics
    (`nextTick` → microtasks → immediates → timers, `beforeExit`/`exit`)
  - `fs` (sync, callbacks, promises, streams), `Buffer`, `URL`, `stream`, `events`, `util`
  - `child_process` (`spawn` with stdio pipes, `execFile`, `spawnSync`, `kill`)
  - Node-formatted errors
  - ES modules: imports, live bindings, cycles, top-level await, `import.meta`, `import()`, JSON,
    and CommonJS interop including `require(esm)` (ADR-0013). The real `create-vite` CLI
    scaffolds a React app
  - `net`, `http` and `dns` over the kernel's sockets, between processes or within one
  - `zlib` (byte-identical to Node's) and `crypto` (digests, HMAC, PBKDF2, HKDF, random, secret
    keys, and WebCrypto digest/HMAC/PBKDF2/HKDF)
  - `worker_threads` (messages, transfers, `SharedArrayBuffer`, `BroadcastChannel`, `terminate`)
    and `node:wasi`, enough for wasm32-wasi N-API addons such as Rolldown (ADR-0016)
  - `fs.watch` (also recursive), `fs.promises.watch` and `fs.watchFile`
  - `v8.serialize` (V8's wire format, byte for byte) and `node:test`
  - 68 of 72 builtin modules load; the rest are `repl` and the inspector modules (see
    [the M1 plan](docs/milestones/M1.md))
- **npm and sh** (ADR-0015): webcore's own programs, running as processes on its Node.
  - **npm:** `install`, `ci`, `uninstall`, `run`, `exec`/`npx`, `init`/`create`, with npm's
    `node_modules` layout, lockfile and `.bin` links. Native packages are swapped for their
    wasm32-wasi builds.
  - **sh:** a POSIX-subset shell, which Node's `child_process` uses as its shell.
- **Preview:** a server listening on a port is served in an iframe on `p<port>.localhost`, through a
  Service Worker and a bridge to the kernel. Page requests, cookies and WebSockets work (ADR-0014).
- **WASI preview1:** args, env, preopens, files, directories, pipes, clocks, random, sleeps.
- **Structured events:** spawn, exit, fs changes, and ports opening and closing (ADR-0010).
- **Hosts:** browser (`@webcore/kernel/web`) and headless Node (`@webcore/kernel/node`).

## Quick start

Requires Node ≥ 22.13 and pnpm.

```bash
pnpm install
```

```bash
pnpm dev
```

`pnpm dev` builds the WASI test binaries, the Node standard library bundle and the userland
programs first.

`pnpm dev` opens the playground at http://localhost:5180: a terminal, example commands, a preview
pane, and a live kernel event log. Try "HTTP server + preview", or the Vite flow: "npm create vite
(React)", "npm install", "npm run dev (Vite)", then "Edit App.jsx (HMR)" while it runs.

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
    src/personalities/   wasi/ (WASI preview1), node/ (Node.js: realm, event loop, bindings)
    src/host/            ProcessHosts, exec/pipeline helpers, mini shell, root filesystem, HTTP client
    src/lib/             environment-free libraries (the HTTP/1.1 parser)
    src/preview/         preview bridge, Service Worker, client script, Vite plugin (ADR-0014)
    test/                unit + end-to-end tests
  node-lib/              Node v24.21.0's lib/, vendored, plus the bundle builder (ADR-0012)
  userland/              webcore's own programs in TypeScript: sh, npm, npx (ADR-0015)
  wat-bin/               hand-written WASI programs (echo, cat, wc, ls), no C toolchain needed
apps/
  playground/            browser demo (Vite)
```

## Embedding (current API)

```ts
import { Kernel, installRootfs, exec, DEFAULT_ENV } from '@webcore/kernel'
import { webProcessHost } from '@webcore/kernel/web' // or nodeProcessHost from '@webcore/kernel/node'

// webProcessHost keeps two Workers booted for fast spawns ({ warmWorkers: n } to change it)
const kernel = new Kernel({ host: webProcessHost(), assets: { 'node-lib': nodeLibBytes } })
// userland: @webcore/userland's dist/userland.json (sh, npm, npx)
installRootfs(kernel, { echo: echoWasmBytes /* … */ }, userland)
kernel.events.subscribe((event) => console.log(event))

const { code, stdout } = await exec(kernel, ['node', '-p', '6 * 7'], { env: { ...DEFAULT_ENV } })
```

The page must be cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp`). See ADR-0002 and ADR-0009.

Previews (ADR-0014) need the `webcorePreview()` Vite plugin from `@webcore/kernel/vite` (or the same
three files and a boot-page fallback on `p<port>.*` hosts), and a bridge on the page:

```ts
import { PreviewBridge } from '@webcore/kernel'

const bridge = new PreviewBridge(kernel) // previews on p<port>.localhost:<this page's port>
bridge.listen()
kernel.events.subscribe((event) => {
  if (event.type === 'net.listen') iframe.src = bridge.url(event.port)
})
```

## Known limitations

- **Networking is local only.**
  - Global `fetch` reaches the internet (with CORS), but Node's `http`/`https` modules can't yet:
    they need TLS (after M1).
  - No Unix domain sockets, UDP or HTTP/2.
  - Previews work inside the page that runs the kernel, not in a tab of their own.
- **crypto has no OpenSSL.** Ciphers, signatures, asymmetric keys and TLS throw. zlib has no
  Brotli or zstd.
- **npm is webcore's own.** It skips dependencies' install scripts, and doesn't publish or do
  workspaces, `git:`/`file:` specs or global installs (ADR-0015).
- **`worker_threads` can't receive synchronously across threads** (`Atomics.wait` +
  `receiveMessageOnPort`), `SHARE_ENV` copies the environment, and `resourceLimits` aren't enforced
  (ADR-0016).
- **The kernel runs on the page's main thread**, and the page must be cross-origin isolated. It
  moves into an isolated runtime iframe in M1f (ADR-0009).
- **Background tabs are slow.** Browsers throttle hidden pages, and every process feels it.
- **The VFS is in-memory and mutable.** The content-addressed copy-on-write store comes in M2
  (ADR-0007).
- **No TTY/PTY yet**: stdio is pipes and files (M2).
- **The terminal's shell is host-side and minimal.** It hands `rm`, `mkdir` and similar to
  `/bin/sh`. A terminal that runs a shell process needs a PTY (M2), and coreutils arrive with
  BusyBox via WASIX.
- **WASI binaries are hand-written WAT.** Real wasi-sdk/WASIX builds arrive in M2.
