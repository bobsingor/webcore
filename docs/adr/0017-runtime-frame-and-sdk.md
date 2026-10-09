# 0017. The runtime frame isolates itself; pages reach it through one MessagePort

- **Status:** Accepted · implemented in M1f
- **Date:** 2026-10-09

## Context

ADR-0009 puts the kernel in an iframe on its own origin, cross-origin isolated "so the embedding
page doesn't need to be". It left two questions open:
- **How does a frame become isolated without its embedder?** `SharedArrayBuffer` needs
  cross-origin isolation, which used to require COOP and COEP on the top-level page. A nested frame
  could only inherit it.
- **How do previews reach the kernel?** A preview page asks its parent for a channel to the bridge
  (ADR-0014). The parent is now the embedding page, not the page that runs the kernel.

## Decision

**The runtime page isolates itself with Document-Isolation-Policy.** Chromium (137 and later)
supports `Document-Isolation-Policy`. With it, a document and its dedicated Workers get their own
process and are cross-origin isolated, whatever embeds them. Every response from the runtime host
carries:

| Header | Why |
|---|---|
| `Document-Isolation-Policy: isolate-and-require-corp` | Isolation under any embedder, in Chromium |
| `Cross-Origin-Embedder-Policy: require-corp` | Isolation inherited from an isolated embedder, in browsers without DIP |
| `Cross-Origin-Resource-Policy: cross-origin` | Lets an isolated (COEP) embedder load the frame |

Browsers without DIP need an embedding page that is isolated itself (`COOP: same-origin`, and
`COEP: require-corp` or `credentialless`). The SDK always gives the frame
`allow="cross-origin-isolated"`. A runtime that isn't isolated says so, and `connect()` fails with
that explanation.

**One MessagePort, set up by two window messages:**
1. The runtime posts `webcore:runtime-loaded` to its parent once it listens.
2. The SDK posts `webcore:runtime-hello` with a port, addressed to the runtime's origin. The
   runtime accepts it once, and only from its parent.
3. On the port, the runtime answers `ready`, with the preview-origin template, or `failed`.

Each runtime frame serves one embedding page and has its own kernel. Everything else travels on
the port. The SDK trusts no other window message from the runtime.

**The API is explicit and asynchronous** (the SDK's `Runtime`):
- **files:** `readFile`, `writeFile`, `mkdir`, `readdir`, `stat`, `rm`, `rename`. Changes emit
  the same `fs.change` events as a process's syscalls, so watchers (Vite) see them.
- **processes:** `spawn`, with stdin, stdout, stderr and signals, and `exec`.
- **shell sessions**, which keep their working directory and variables.
- **kernel events**, forwarded only while someone subscribes, and batched.
- **previews:** URLs, and channel relays.

Calls are request and response. A job's output streams on the same port, keyed by a job id the
SDK picks, so output never arrives before its job is known, and a job's exit always follows its
output.

**The embedding page relays preview channels.** Preview pages post `webcore:connect` with a port to
their parent, the embedding page. If the sender is one of the runtime's preview origins
(`p<port>.<host>`), the SDK forwards the port to the runtime with that origin. It reads nothing
else from preview pages. The runtime checks the origin again and binds the channel to that port: a
preview can fetch only from the server it previews. WebSockets may connect to any port, as in a
browser, and servers see the page's `Origin`.

**Origins.** Locally, the app is on `localhost:5180`, the runtime on `webcore.localhost:5190`,
and previews on `p<port>.localhost:5190`. The hostnames differ, so the app's host-only cookies
don't reach the runtime. A deployment puts the runtime on a domain separate from the app's, with a
wildcard domain for previews.

## Consequences

- In Chromium, an embedding page needs no special headers. It loads the SDK (15 KB) and no kernel
  code.
- Embedders in Firefox and Safari must be cross-origin isolated themselves until those browsers
  ship DIP. Both setups were verified in Chromium; Firefox and Safari weren't tested.
- Everything between the page and the kernel is asynchronous. The synchronous VFS access the
  playground used to have is gone.
- Any page can embed a runtime deployment. Each embedder gets its own kernel in its own frame,
  with storage partitioned by the browser. A deployment can restrict embedders with CSP
  `frame-ancestors`.
- The runtime ships as a static site (`@webcore/runtime`) plus these headers. Preview hosts also
  need the boot-page fallback (ADR-0014).
- Browsers deprioritize hidden pages, and the runtime frame with them.

## Alternatives considered

- **Require COOP and COEP on the embedding page**, as WebContainers do. This works in every
  browser, but it's intrusive: it breaks OAuth popups and third-party embeds. ADR-0009 rejected it
  as the default. It remains the fallback.
- **Open the runtime in its own window**, isolated with COOP and COEP. This works without DIP, but
  a separate window is poor UX, and popups get blocked.
- **Embed previews inside the runtime frame.** No relay would be needed, but the embedding page
  couldn't lay previews out, and they would share the runtime's process.
- **A proxy API (Comlink-style)** instead of an explicit protocol. It's less code, but its
  capabilities are implicit, and it's harder to secure and to version.
