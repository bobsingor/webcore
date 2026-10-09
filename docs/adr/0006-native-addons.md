# 0006. Native addons via Wasm N-API plus install-time substitution

- **Status:** Accepted · wasm32-wasi substitution for napi-rs packages in M1d ([0015](0015-own-npm-and-userland.md))
- **Date:** 2026-10-09

## Context

The current JS toolchain is increasingly native. Vite uses Rolldown (Rust), Tailwind 4 uses oxide
(Rust), and the ecosystem also uses esbuild (Go), lightningcss, SWC and better-sqlite3. None of these
ship browser-compatible JavaScript. Without a plan for native addons, `npm run dev` fails for most
modern templates.

Two facts help:

- napi-rs can target `wasm32-wasip1-threads`. Rolldown, Oxc, lightningcss and Tailwind's oxide
  publish `@…/wasm32-wasi` packages that run through **emnapi** (N-API implemented in JS over Wasm).
- Several projects publish JS/Wasm equivalents: `esbuild-wasm` and `@rollup/wasm-node`.

## Decision

- The Node personality implements N-API for Wasm addons via emnapi, running them as WASI modules on
  the kernel (threads via Workers + shared memory).
- The package installer ships a **substitution table**: when a package resolves to a platform-specific
  native binary, it installs the Wasm variant instead, for example:
  - `@rolldown/binding-*` → `@rolldown/binding-wasm32-wasi`
  - `esbuild` → `esbuild-wasm`
  - `better-sqlite3` → a shim over the kernel's SQLite
- Installs report `os: linux`, `cpu: wasm32` so optional-dependency selection picks Wasm builds where
  they exist.
- The table is data, versioned and community-maintained. A compatibility dashboard lists known-good
  packages.

## Consequences

- Most modern templates work without any change by the user.
- Some packages will never work (those with C++ addons and no Wasm build). We report them clearly at
  install time instead of failing mysteriously at runtime.
