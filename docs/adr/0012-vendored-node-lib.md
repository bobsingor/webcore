# 0012. Vendor Node's `lib/` at a pinned LTS; ship it as one shared-memory bundle

- **Status:** Accepted
- **Date:** 2026-10-09

## Context

ADR-0005 commits to running Node's own JavaScript standard library. We need to decide three things:

- **Which version?**
- **How do the sources reach the repository?**
- **How do they reach each process?** Every process needs them, and processes are short-lived Workers.

The version also bounds the JavaScript features `lib/` may use, and browsers must support them.

## Decision

- **Version:** Node **v24.21.0** (Active LTS). Its V8 13.6 is comfortably inside what current
  Chromium, Firefox and Safari engines support. Upgrades are deliberate, one LTS line at a time.
- **Vendoring:** `packages/node-lib/vendor/` holds pristine copies of `lib/`, the JavaScript `deps` that
  `lib/` loads (`acorn`, `cjs-module-lexer`, `minimatch`) and Node's `LICENSE`. A script fetches them
  from the pinned tag. They are committed, so builds are offline and reproducible, and upgrade diffs
  are reviewable.
- **No patches to vendored files.** Behaviour differences are implemented in bindings. When a whole
  module must be replaced, the replacement lives in `packages/node-lib/overrides/` under the same
  builtin id. The first example is `internal/deps/undici/undici`, which re-exports the browser's
  native `fetch`, `WebSocket` and friends.
- **Bundle:** the build produces `dist/node-lib.bin`: a small JSON index (id → offset and length)
  followed by all sources as UTF-8. The host loads it once and the kernel copies it into a
  `SharedArrayBuffer` asset. Every process receives the same shared memory in its boot message and
  decodes a module only when it is first required, about 150 of 372 at startup.

## Consequences

- Process startup doesn't pay for parsing or copying the whole standard library. Shared memory is
  free to pass to each Worker.
- Pristine vendoring makes the binding layer the single place where webcore differs from Node, and
  makes Node upgrades mechanical: update the vendor, rebuild, and fix the bindings the coverage
  report flags.
- Node's `LICENSE` (MIT plus third-party notices) ships with the bundle.
- The repository grows by about 7 MB.
