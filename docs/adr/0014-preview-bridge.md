# 0014. Loopback TCP, and previews served through a Service Worker bridge

- **Status:** Accepted · implemented in M1c
- **Date:** 2026-10-09

## Context

ADR-0008 puts virtual sockets in the kernel and serves previews through a Service Worker.
ADR-0009 gives each preview its own origin. M1c implements both, which settles questions those
records left open:

- which addresses exist inside the sandbox
- how a Service Worker on a preview origin reaches a kernel that runs in another page
- what to do about the parts of HTTP a Service Worker can't express (cookies, WebSockets)

## Decision

**One host, keyed by port.** Every local address (`127.0.0.0/8`, `::1`, `0.0.0.0`, `::`,
`localhost`, `*.localhost`) is an alias for the same virtual host. A listener owns a port, whatever
address it bound. A connection is two kernel pipes, one per direction, so it inherits blocking
reads, backpressure, half-close (`shutdown`) and EOF. Name resolution answers only for `localhost`.
Everything else fails with `ENOTFOUND` until outbound networking exists.

The syscalls are `listen(address, port)`, `accept(fd)`, `connect(address, port)` and
`shutdown(fd)`. Opening and closing a listener emit `net.listen` and `net.close` events, which is
how the host discovers ports.

**Preview origins are `p<port>.<host>`.** Locally that is `p3000.localhost:5180`, which browsers
resolve to loopback and treat as a secure context. Deployments use a wildcard domain. The first
hostname label carries the port, so the Service Worker and the bridge agree on the port without
configuration. A project prefix can follow it (`p3000-myproj.example.dev`).

**The bridge lives in the page that runs the kernel.** Three static assets are served on every
preview origin (`@webcore/kernel/vite` does this for Vite):

| Asset | Role |
|---|---|
| `/__webcore/boot.html` | Registers the Service Worker and connects it to the bridge, then loads the requested path. It is also the fallback page for any document request before the worker exists |
| `/__webcore_sw.js` | Forwards every same-origin request to the bridge and streams the response back. It adds `COEP: credentialless` and `CORP: cross-origin`, so a cross-origin-isolated page can embed the preview |
| `/__webcore/client.js` | Injected as the first script of every HTML document. It hands the worker a new channel when the worker asks for one, relays WebSockets, and reports navigations to the embedder |

Channels are MessagePorts. A preview page posts `{ type: 'webcore:connect' }` with a port to its
parent. The bridge accepts it only from origins it generated.

**Service Workers are stopped when idle, and lose their channel.** The worker then asks its pages
for a new one (`webcore:need-channel`). A navigation with no page left to ask gets the boot page,
which reconnects and reloads.

**The bridge fills in what Service Workers can't express:**
- **Cookies:** responses built by a worker can't carry `Set-Cookie`, so the bridge keeps a
  per-port cookie jar and sends it with each request. `document.cookie` doesn't see these cookies.
- **WebSockets:** the client script replaces `WebSocket` for URLs that point into the kernel. The
  bridge performs the HTTP upgrade and RFC 6455 framing on a kernel socket.
- **Compression:** the bridge strips `Accept-Encoding` from requests, and decompresses gzip and
  deflate responses if a server compresses anyway.

Requests use one connection each (`Connection: close`) and keep the preview's `Host`, so absolute
URLs a server builds point back at the preview.

## Consequences

- `node server.js` works in a preview with no configuration. So do servers on `localhost`,
  `127.0.0.1` or `::`. The IPv4/IPv6 `localhost` mismatches seen on real machines can't happen.
- Two servers can't share a port on different local addresses. Nothing in the M1 workload needs
  that.
- Previews work only inside the page that runs the kernel. Opening one in its own tab shows an
  explanation. Supporting new tabs needs a channel that doesn't go through `window.parent`, such as
  the runtime iframe (ADR-0009, M1e) embedded in the preview.
- HTML documents are buffered whole to inject the client script, so streamed HTML arrives at once.
- `p<port>` hostnames must be routable to the page host: wildcard DNS and a boot-page fallback for
  every path on those hosts.
