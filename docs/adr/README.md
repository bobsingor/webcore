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
| [0005](0005-js-on-the-host-engine.md) | JavaScript runs on the host engine; Node built from Node's own `lib/` | Accepted · shim in M0 |
| [0006](0006-native-addons.md) | Native addons via Wasm N-API plus install-time substitution | Accepted |
| [0007](0007-content-addressed-cow-vfs.md) | Content-addressed, copy-on-write VFS; snapshots are tree hashes | Accepted |
| [0008](0008-virtual-networking.md) | Virtual sockets in the kernel; Service Worker preview; optional TCP relay | Accepted |
| [0009](0009-origin-isolation.md) | Runtime and previews live on their own origins | Accepted |
| [0010](0010-structured-event-log.md) | Every kernel action emits a structured event | Accepted · basic events in M0 |
| [0011](0011-environment-agnostic-core.md) | Kernel core is environment-agnostic (browser and headless) | Accepted · implemented in M0 |
