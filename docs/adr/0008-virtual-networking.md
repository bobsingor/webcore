# 0008. Virtual sockets in the kernel; Service Worker preview; optional TCP relay

- **Status:** Accepted
- **Date:** 2026-10-09

## Context

Development environments are networked:

- dev servers listen on ports
- apps connect to databases
- package managers download from registries
- git talks to remotes

Browsers expose `fetch`, WebSocket and WebTransport, but not raw TCP, listening sockets, or requests
that ignore CORS.

## Decision

- **Inside the sandbox**, the kernel implements a virtual socket layer: TCP-like streams, UDP-like
  datagrams, `listen`/`accept`/`connect` on virtual addresses, and loopback for `localhost`.
  Processes connect to each other with no real network involved. Unmodified drivers work against
  in-sandbox databases.
- **Preview:** each listening port maps to a preview origin. A Service Worker on that origin forwards
  each HTTP request as a connection to the kernel socket and streams the response back. WebSocket
  upgrades use the same path.
- **Outbound HTTP(S)** goes through `fetch` (registries such as npm support CORS). Requests that hit
  CORS walls can go through an optional CORS proxy.
- **Outbound raw TCP** (git over ssh, remote Postgres) goes through an optional, self-hostable
  WebSocket→TCP relay with allow-lists.

## Consequences

- Everything that only talks to `localhost` works fully offline and client-side.
- The relay and proxy are the only server components, and are optional. They are natural hosted
  offerings with no lock-in, because they are self-hostable.
- Implementing socket semantics (half-close, backpressure, `SO_REUSEADDR` expectations) faithfully is
  real work. It is tested against Node's `net` tests.
