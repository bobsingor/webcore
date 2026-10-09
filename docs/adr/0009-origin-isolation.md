# 0009. Runtime and previews live on their own origins

- **Status:** Accepted · preview origins implemented in M1c ([0014](0014-preview-bridge.md))
- **Date:** 2026-10-09

## Context

The runtime executes arbitrary code, often AI-generated or pulled from npm. If that code ran on the
embedding application's origin, it could read that app's cookies, localStorage and tokens, and call
its APIs as the user.

`SharedArrayBuffer` also requires cross-origin isolation (COOP/COEP). Forcing those headers onto every
embedding application is intrusive: it breaks third-party embeds, OAuth popups, and so on.

## Decision

- The kernel runs inside an iframe on a **dedicated runtime origin**. That origin is cross-origin
  isolated, so the embedding page doesn't need to be.
- Each preview is served from its **own origin** (`<project>-<port>.<preview-domain>`), never the
  runtime origin. Previewed apps can't touch the kernel or each other.
- The host SDK talks to the runtime iframe over `postMessage` and `MessagePort`, with an explicit
  capability-based API. The SDK never trusts messages from preview origins.
- Self-hosters configure their own runtime and preview domains. A hosted default is offered for
  convenience.

## Consequences

- The open-source project needs a story for "where does the runtime origin live": a hosted default
  plus documented self-hosting with wildcard DNS and TLS.
- All host↔kernel calls are async messages. The API is designed for that from the start.
- M0's playground hosts the kernel directly on the page for simplicity. Moving it into the isolated
  iframe is an M1 task, and nothing in the kernel depends on where it is hosted
  ([0011](0011-environment-agnostic-core.md)).
