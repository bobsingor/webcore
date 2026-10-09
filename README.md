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

## Status: M2c, real shell ✅ (M2 done)

`node` is **Node.js v24.21.0**: Node's own JavaScript standard library, unmodified, running on the
browser's JavaScript engine over bindings written against the kernel. The bindings replace the C++
half of Node (ADR-0005, ADR-0012). Servers it starts open in a preview pane (ADR-0014), and
`npm create vite` + `npm install` work against the real npm registry (ADR-0015).

M1's exit criterion runs in the browser: `npm run dev` starts Vite 8 (with Rolldown's wasm build and
its worker threads), the React app renders in the preview pane, and edits update it in place (HMR).
The kernel runs in an iframe on its own, cross-origin-isolated origin. Pages embed it with
`@webcore/sdk` and need no special headers in Chromium (ADR-0009, ADR-0017). The playground's
terminal is xterm.js on a kernel pseudo-terminal, running BusyBox's hush, compiled from C to
WebAssembly (WASIX), with line editing and job control: Ctrl+C reaches the foreground job, Ctrl+Z
stops it, `fg` and `bg` continue it, and `node` starts Node's REPL (ADR-0018, ADR-0020). `ls`,
`grep`, `sed`, `awk`, `vi`, `less` and a hundred more commands are BusyBox too. `/home` is saved as
it changes and comes back after a reload, `node_modules` included. Snapshots, restores and forks
take milliseconds (ADR-0007, ADR-0019).

```sh
user@webcore:~$ node -p "process.version + ' on ' + process.platform"
v24.21.0 on linux
[exit 0 · 61 ms]
user@webcore:~$ node -e "const c = require('child_process').spawn('wc'); c.stdout.pipe(process.stdout); c.stdin.end('one two three\n')"
        1         3        14
user@webcore:~$ seq 5 | awk '{ s += $1 } END { print s }' | sed 's/^/sum: /'
sum: 15
```

What works:

- **Kernel:**
  - processes, fd tables, pipes with blocking reads, backpressure, EOF and EPIPE
  - a content-addressed, copy-on-write VFS: snapshots are tree hashes, restores share the stored
    data until a file is written, and identical files are stored once (ADR-0007)
  - `spawn`/`wait`/`kill`, and `vfork`/`execve`/`wait4` with close-on-exec fds (ADR-0020)
  - signals with per-process dispositions: default actions, ignored, or delivered to handlers,
    with `EINTR` and `SA_RESTART` for blocked calls (ADR-0018, ADR-0020)
  - job control: stop and continue (`^Z`, `fg`, `bg`), reported by `wait4`
  - pseudo-terminals with Linux's line discipline (editing, echo, `^C`, raw mode, window size),
    sessions, and foreground process groups (ADR-0018)
  - a kernel-side `spawnSync`
  - virtual TCP on one loopback host: `listen`/`accept`/`connect`/`shutdown` (ADR-0014)
  - symbolic and hard links, file modes, times and umask, process groups (Ctrl+C stops a whole
    job), `poll`, and `extract`, which unpacks an npm tarball in one syscall (ADR-0015)
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
  - terminals: `isTTY`, colors, window size and resize events, raw mode, `readline`, and the REPL
  - `vm` contexts, approximated in one realm (a Worker can't create another)
  - 69 of 72 builtin modules load; the rest are the inspector and trace modules (see
    [the M1 plan](docs/milestones/M1.md))
- **BusyBox 1.38** (ADR-0020), built from source with a pinned WASIX toolchain: hush is `/bin/sh`
  (also for Node's `child_process` and npm scripts), with history, line editing, completion and job
  control. Its applets include coreutils, `grep`, `sed`, `awk`, `find`, `xargs`, `diff`, `tar`,
  `gzip`, `vi`, `less` and `timeout`.
- **npm** (ADR-0015): webcore's own program, running as a process on its Node. `install`, `ci`,
  `uninstall`, `run`, `exec`/`npx`, `init`/`create`, with npm's `node_modules` layout, lockfile and
  `.bin` links. Native packages are swapped for their wasm32-wasi builds.
- **Preview:** a server listening on a port is served in an iframe on `p<port>.localhost`, through a
  Service Worker and a bridge to the kernel. Page requests, cookies and WebSockets work (ADR-0014).
- **WASI preview1 and WASIX** (ADR-0004, ADR-0020): files, directories, pipes, clocks, polls,
  processes (vfork, exec, posix_spawn, waitpid), signals, terminals and futexes. libwebcore, which
  webcore's C programs link, gives them the kernel's process groups, termios and file modes.
- **Workspaces** (ADR-0019): `/home` saved to the runtime origin's storage (OPFS) a moment after it
  changes, restored on the next load, and forkable. One tab writes a workspace; others read it.
- **Structured events:** spawn, exit, fs changes, snapshots and saves, and ports opening and closing
  (ADR-0010).
- **Isolation** (ADR-0017): the runtime frame isolates itself with Document-Isolation-Policy, and
  the embedding page reaches it through one MessagePort, with an async API for files, processes,
  shell sessions, events and previews.
- **Hosts:** the runtime frame (`@webcore/runtime`, which uses `@webcore/kernel/web`) and headless
  Node (`@webcore/kernel/node`).

## Quick start

Requires Node ≥ 22.13 and pnpm, plus `make`, `patch` and a C compiler (`cc`) for BusyBox's build
(macOS or Linux).

```bash
pnpm install
```

```bash
pnpm dev
```

`pnpm dev` builds BusyBox and the WASIX test programs, the Node standard library bundle and the
userland programs first. The first build downloads the WASIX toolchain (about 750 MB) into
`node_modules/.cache`; later builds skip what hasn't changed.

`pnpm dev` starts two servers: the runtime on http://webcore.localhost:5190 and the playground on
http://localhost:5180. Open the playground: a terminal, example commands, a preview pane, and a
live kernel event log. Try "HTTP server + preview", or the Vite flow: "npm create vite
(React)", "npm install", "npm run dev (Vite)", then "Edit App.jsx (HMR)" while it runs.

```bash
pnpm test
```

`pnpm test` runs end to end in Node with real Workers and real Wasm.

```bash
pnpm test:node
```

`pnpm test:node` runs Node's own `test/parallel` files listed in
`packages/kernel/test/node-parallel.txt`: the 2,745 of 4,543 that pass (or skip) on webcore today. The tests are fetched
into a cache on first use. Add `--all` to run every file, and `--update` to refresh the list.

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
    src/kernel/          Kernel, processes, VFS and snapshots, pipes, PTYs, open files, exec, events
    src/process/         Worker entries (browser, Node) and the process-side syscall client
    src/personalities/   wasi/ (WASI preview1, WASIX), node/ (Node.js: realm, event loop, bindings)
    src/host/            ProcessHosts, exec/pipeline helpers, shell sessions, root filesystem, HTTP
                         client, workspaces
    src/lib/             environment-free libraries (the HTTP/1.1 parser)
    src/preview/         preview bridge, Service Worker, client script, Vite plugin (ADR-0014)
    test/                unit + end-to-end tests
  node-lib/              Node v24.21.0's lib/, vendored, plus the bundle builder (ADR-0012)
  userland/              webcore's own programs in TypeScript: npm, npx (ADR-0015)
  wasix-bin/             the pinned WASIX toolchain, BusyBox's build, libwebcore and C test
                         programs (ADR-0020)
  sdk/                   @webcore/sdk: connect() and the protocol to the runtime frame (ADR-0017)
  runtime/               @webcore/runtime: the runtime page, a static site with isolation headers
apps/
  playground/            browser demo (Vite), embedding the runtime through the SDK
```

## Embedding (current API)

A page embeds webcore with `@webcore/sdk`. `connect()` starts the runtime in an invisible iframe and
returns an async API (ADR-0017):

```ts
import { connect } from '@webcore/sdk'

// A @webcore/runtime deployment; /home is saved in workspace 'my-project' and back on the next load
const runtime = await connect({ url: 'https://runtime.example.dev/', workspace: 'my-project' })

await runtime.fs.writeFile('/home/user/hello.js', 'console.log(6 * 7)')
const { code, stdout } = await runtime.exec(['node', 'hello.js'])

const before = await runtime.snapshot() // a tree hash, in milliseconds
const experiment = await runtime.fork() // a second runtime, from that snapshot, in its own workspace
await runtime.restore(before) // back to how /home was

const shell = await runtime.createShell() // keeps cd and export between lines
await shell.run('npm create vite@latest app -- --template react --no-interactive', { onStdout: (chunk) => log(chunk) })

// A terminal for xterm.js: a login shell on a kernel pseudo-terminal
const tty = await runtime.openTerminal({ cols: xterm.cols, rows: xterm.rows, onData: (chunk) => xterm.write(chunk) })
xterm.onData((keys) => tty.write(keys))
xterm.onResize(({ cols, rows }) => tty.resize(cols, rows))

runtime.events.subscribe((event) => {
  if (event.type === 'net.listen') iframe.src = runtime.previewUrl(event.port)
})
```

The runtime (`@webcore/runtime`, built with `vite build`) is a static site. Its host must send
these headers on every response:
- `Document-Isolation-Policy: isolate-and-require-corp`
- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Resource-Policy: cross-origin`

Previews are served from `p<port>.<runtime host>`. Every page request there gets the boot page
(ADR-0014). In browsers without Document-Isolation-Policy, the embedding page must be cross-origin
isolated itself (`Cross-Origin-Opener-Policy: same-origin`, and `Cross-Origin-Embedder-Policy:
require-corp` or `credentialless`).

Headless, the kernel is used directly:

```ts
import { Kernel, installRootfs, exec, DEFAULT_ENV } from '@webcore/kernel'
import { nodeProcessHost } from '@webcore/kernel/node'

const kernel = new Kernel({ host: nodeProcessHost(), assets: { 'node-lib': nodeLibBytes } })
// busybox: @webcore/wasix-bin's busybox.wasm and busybox.links (busyboxLinks parses the latter);
// userland: @webcore/userland's dist/userland.json (npm, npx)
installRootfs(kernel, { busybox: { binary: busyboxBytes, links }, userland })
const { code, stdout } = await exec(kernel, ['node', '-p', '6 * 7'], { env: { ...DEFAULT_ENV } })
```

## Known limitations

- **Networking is local only.**
  - Global `fetch` reaches the internet (with CORS), but Node's `http`/`https` modules can't yet:
    they need TLS (after M1).
  - No Unix domain sockets, UDP or HTTP/2.
  - Previews work in frames of the embedding page, not in a tab of their own.
- **crypto has no OpenSSL.** Ciphers, signatures, asymmetric keys and TLS throw. zlib has no
  Brotli or zstd.
- **npm is webcore's own.** It skips dependencies' install scripts, and doesn't publish or do
  workspaces, `git:`/`file:` specs or global installs (ADR-0015).
- **`worker_threads` can't receive synchronously across threads** (`Atomics.wait` +
  `receiveMessageOnPort`), `SHARE_ENV` copies the environment, and `resourceLimits` aren't enforced
  (ADR-0016).
- **Embedding without headers needs Chromium.** Firefox and Safari don't have
  Document-Isolation-Policy yet, so there the embedding page must be cross-origin isolated
  (ADR-0017). They haven't been tested.
- **There is no hosted runtime yet.** `connect()` needs the URL of a `@webcore/runtime` deployment.
- **Background tabs are slow.** Browsers throttle hidden pages, and every process feels it.
- **Workspaces stay in the browser.** They're per embedding site, aren't synced across devices, and
  can be evicted under storage pressure. Snapshots don't keep hard links or times. Lazy mounts for
  large runtime images come with Python in M3.
- **Signals can't interrupt running code.** A handler runs once the program yields or makes a
  syscall; default actions, stops and `SIGKILL` take effect at once.
- **No `fork()` for Wasm programs.** BusyBox needs only vfork. bash and other programs that fork
  would need Asyncify (ADR-0020). WASIX threads and sockets aren't mapped to the kernel yet.
- **One user.** Every file belongs to uid 1000; there are modes but no permission checks.
