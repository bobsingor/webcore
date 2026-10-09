# 0013. ES modules run as two-phase generators compiled from source

- **Status:** Accepted · implemented in M1b
- **Date:** 2026-10-09

## Context

Node's ESM loader is JavaScript, but it drives `ModuleWrap`, a C++ wrapper around V8 module records:
construct from source, list requests, link, instantiate the graph, then evaluate it (asynchronously,
or synchronously for `require(esm)`, which Node 24 enables by default).

Browsers expose no API to build a module record from source text with custom linking. The options:

1. **Native modules served by URL.** A Service Worker serves each module at a stable URL, and
   specifiers are rewritten to those URLs. Browsers provide real live bindings, cycles and top-level
   await. But evaluation is always asynchronous, so `require(esm)` is impossible. It also needs a
   Service Worker, which headless hosts don't have, and `import.meta.url` must be rewritten anyway.
2. **Blob URLs.** Same as option 1 without a Service Worker, but cycles are impossible, because a
   module's URL must exist before the modules that import it.
3. **SystemJS-style register format.** Hoist declarations into an outer function and run the body
   in an `execute()` function. This works, but loses TDZ semantics, moves code (breaking stack-trace
   line numbers), and needs a full declaration-hoisting transform.
4. **Two-phase generators.** Keep the body in place inside a generator function, and use `yield` to
   split instantiation from evaluation.

## Decision

Option 4. Each module compiles to:

```js
(function* (__wc) {"use strict";__wc.x({ name: () => local, … });yield;<module body, edited in place>
})
```

- **Instantiation** is the first `next()`. Function declarations are hoisted, `let`/`const`/`class`
  are in their TDZ, and the export getters close over the real bindings. This gives live bindings,
  correct cycles and genuine TDZ errors for free.
- **Evaluation** is the second `next()`. Modules with top-level await are `async function*`. A graph
  without top-level await evaluates synchronously, which is what `require(esm)` needs.
- **Edits are made in place**, using Node's bundled acorn, so line numbers survive:
  - import declarations are removed, and references become `__wc.d[i].name` (scope-aware, so
    shadowed names are left alone, and shorthand properties are expanded)
  - the `export` keyword is removed, and exported names become getters
  - `import.meta` and `import()` are routed to Node's own callbacks
- **Namespaces** are null-prototype objects with sorted live getters and `Symbol.toStringTag: 'Module'`.
  Synthetic modules (CommonJS facades, builtins, JSON) use the same namespaces.
- **`import()` in CommonJS and `vm` scripts** is rewritten to a global dispatcher that carries the
  referrer. A cheap textual pre-check means sources without `import(` are never parsed.

## Consequences

- **The same mechanism works in browsers and headless.** No Service Worker is involved.
- **`require(esm)`, cycles, TDZ, live bindings and top-level await behave like V8.** Stack traces
  show `file:///…` URLs with the original line numbers.
- **Every ES module is parsed once by acorn.** Caching compiled output by content hash is a natural
  follow-up (ADR-0007).
- **Known gaps:**
  - namespace properties are accessors rather than data properties
  - `export *` name clashes resolve to the first module rather than being excluded as ambiguous
  - modules in an async graph evaluate sequentially rather than in parallel
  - source-phase imports and `vm.SourceTextModule` (which needs vm contexts) are not supported
- **The transform is code that sees every package in the ecosystem.** It needs adversarial tests.
  M1b's first real-world run (create-vite's minified bundle) exposed a scoping bug in `for…of`
  loops that hand-written tests had passed by coincidence.
