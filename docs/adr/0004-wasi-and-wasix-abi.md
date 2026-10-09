# 0004. Wasm binaries use WASI preview1 + WASIX; Emscripten via an adapter

- **Status:** Accepted · preview1 implemented in M0
- **Date:** 2026-10-09

## Context

Inventing our own Wasm syscall ABI would mean building our own libc, toolchain and package ports, and
we would never catch up. Existing options:

- **WASI preview1:** the de facto target (`wasm32-wasip1`) for Rust, C (wasi-sdk), Go (`GOOS=wasip1`)
  and Zig. No sockets, fork, signals or cwd.
- **WASIX** (Wasmer, MIT): a superset of preview1 adding fork/exec, sockets, threads, signals, pipes
  and cwd. It has a libc and many existing ports: bash, CPython, PHP, curl, and others.
- **WASI 0.2/0.3 (component model):** the standards track, with async in 0.3. Not POSIX-shaped (no
  fork), and needs transpiling (jco) in browsers today.
- **Emscripten:** the largest existing ecosystem of browser ports (Pyodide, PGlite, php-wasm, SQLite,
  DuckDB). Each module carries its own JS glue with its own virtual filesystem.

## Decision

- The **WASI personality** implements preview1 fully, then WASIX extensions as needed. Prebuilt WASIX
  binaries then run without modification.
- An **Emscripten adapter** replaces a module's glue FS/syscall layer with calls into the kernel, so
  existing ports share the kernel's VFS, pipes and sockets.
- The **kernel ABI stays our own** ([0003](0003-linux-semantics-and-numbering.md)). WASIX and
  Emscripten are adapters on top of it, which hedges against vendor or standards churn. The component
  model can be added later as another adapter.
- Preopens follow the wasmtime convention: fd 3 is `/` and fd 4 is the process's working directory.

## Consequences

- Rust, C, Go and Zig programs can be compiled with stock toolchains and run unchanged.
- Fork in Wasm requires either asyncify-based stack capture (WASIX's approach) or rewriting callers to
  use `posix_spawn`. We favour spawn and support fork where WASIX binaries need it.
- Adapter work is needed per Emscripten port, but it is mechanical and the ports are high value.
- M0 uses hand-written WAT programs (`packages/wat-bin`) to test preview1 with no toolchain dependency.
  Real binaries built with wasi-sdk/WASIX arrive in M2.
