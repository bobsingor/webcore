# 0005. JavaScript runs on the host engine; Node built from Node's own `lib/`

- **Status:** Accepted · minimal shim in M0, real `lib/` in M1
- **Date:** 2026-10-09

## Context

Node.js is two layers: a large JavaScript standard library (`lib/*.js`, MIT) and a C++ layer (V8,
libuv, OpenSSL) exposed to it through `internalBinding()`. Running Node in the browser can mean:

1. **Compile all of Node, including a JS engine, to Wasm.** JavaScript then runs in an interpreter
   inside Wasm (e.g. QuickJS), which is very slow for compiler-heavy workloads such as TypeScript,
   Vite and bundlers.
2. **Compile Node's C++ to Wasm but run JavaScript on the browser's engine.** This is BrowserPod's
   approach.
3. **Run Node's own `lib/` on the browser's engine and implement the bindings in TypeScript** over
   kernel syscalls.

Developer toolchains are JavaScript-heavy and run for minutes. Speed matters more than anything else.

## Decision

- JavaScript always runs on the host's JIT (V8, JavaScriptCore or SpiderMonkey), never in an
  interpreter inside Wasm.
- From M1, the Node personality loads Node's own `lib/` and implements the `internalBinding()` modules
  (`fs`, `tcp_wrap`, `pipe_wrap`, `process_wrap`, `stream_wrap`, `timers`, `buffer`, `crypto`, …)
  against kernel syscalls. Pure computation (zlib, crypto primitives) uses Wasm builds of the original
  C libraries where WebCrypto is insufficient.
- Node's own test suite (`test/parallel`) is the compatibility metric. Its pass rate is published.
- M0 uses a deliberately small hand-written shim to prove the transport. It is throwaway.

## Consequences

- Behaviour matches Node closely, including error messages and edge cases, because it is Node's own
  code.
- We track Node releases by updating `lib/` and fixing binding drift. That is real ongoing work, but
  far less than reimplementing the standard library.
- Node APIs that need V8 internals (`vm` contexts, inspector, heap snapshots) need approximations
  using the browser's own primitives (realms via iframes or ShadowRealm, and so on).
