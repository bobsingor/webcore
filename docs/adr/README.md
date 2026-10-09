# Architecture decision records

Each record captures one decision that is expensive to change later: the context, the decision, and
its consequences. New records use [`template.md`](template.md). Records are never edited after
acceptance except to change their status. A decision is reversed by a new record that supersedes it.

| # | Decision | Status |
|---|---|---|
| [0001](0001-kernel-is-the-product.md) | The kernel and its syscall ABI are the product; runtimes are packages | Accepted |
| [0002](0002-sync-syscalls-over-shared-memory.md) | Synchronous syscalls over SharedArrayBuffer + Atomics, one Worker per process | Accepted · implemented in M0 |
| [0003](0003-linux-semantics-and-numbering.md) | Kernel ABI follows Linux semantics, flags and errno numbering | Accepted · implemented in M0 |
| [0004](0004-wasi-and-wasix-abi.md) | Wasm binaries use WASI preview1 + WASIX; Emscripten via an adapter | Accepted · preview1 in M0 |
| [0005](0005-js-on-the-host-engine.md) | JavaScript runs on the host engine; Node built from Node's own `lib/` | Accepted · implemented in M1a |
| [0006](0006-native-addons.md) | Native addons via Wasm N-API plus install-time substitution | Accepted · substitution in M1d, wasm32-wasi addons in M1e |
| [0007](0007-content-addressed-cow-vfs.md) | Content-addressed, copy-on-write VFS; snapshots are tree hashes | Accepted · implemented in M2b |
| [0008](0008-virtual-networking.md) | Virtual sockets in the kernel; Service Worker preview; optional TCP relay | Accepted · loopback and previews in M1c |
| [0009](0009-origin-isolation.md) | Runtime and previews live on their own origins | Accepted · preview origins in M1c, runtime iframe in M1f |
| [0010](0010-structured-event-log.md) | Every kernel action emits a structured event | Accepted · basic events in M0 |
| [0011](0011-environment-agnostic-core.md) | Kernel core is environment-agnostic (browser and headless) | Accepted · implemented in M0 |
| [0012](0012-vendored-node-lib.md) | Vendor Node's `lib/` at a pinned LTS; ship it as one shared-memory bundle | Accepted · implemented in M1a |
| [0013](0013-esm-generator-transform.md) | ES modules run as two-phase generators compiled from source | Accepted · implemented in M1b |
| [0014](0014-preview-bridge.md) | Loopback TCP, and previews served through a Service Worker bridge | Accepted · implemented in M1c |
| [0015](0015-own-npm-and-userland.md) | npm and sh are webcore programs; the kernel unpacks packages | Accepted · implemented in M1d |
| [0016](0016-threads-and-worker-threads.md) | Threads are Workers inside a process; worker_threads runs on host MessagePorts | Accepted · implemented in M1e |
| [0017](0017-runtime-frame-and-sdk.md) | The runtime frame isolates itself; pages reach it through one MessagePort | Accepted · implemented in M1f |
| [0018](0018-signals-and-terminals.md) | Signals are dispositions in the kernel; terminals are kernel PTYs | Accepted · implemented in M2a |
| [0019](0019-workspaces.md) | Workspaces persist /home as object packs in the runtime origin's storage | Accepted · implemented in M2b |
