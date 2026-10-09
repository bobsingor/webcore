# 0010. Every kernel action emits a structured event

- **Status:** Accepted · basic events in M0
- **Date:** 2026-10-09

## Context

AI agents need to observe what happened: which process exited with which code, which files changed,
which port opened. Scraping terminal output is brittle.

Replay, time travel, debugging tools and the planned tutorial studio need the same information,
recorded.

## Decision

The kernel exposes one event stream. Events are plain, serializable objects with a monotonic sequence
number and a timestamp:

| Event | Fields |
|---|---|
| `process.spawn` | pid, ppid, argv, cwd |
| `process.exit` | pid, code |
| `fs.change` | op (`create` / `write` / `unlink` / `mkdir` / `rmdir` / `rename`), path; `write` fires when a modified file is closed |
| `net.listen` / `net.close` (M1) | pid, port |
| `syscall` (opt-in, M1) | pid, name, errno, duration |

- Events describe facts, not intentions. They are emitted after the action succeeds.
- Consumers subscribe. The kernel never waits on a consumer.
- With content-addressed snapshots ([0007](0007-content-addressed-cow-vfs.md)), an event log plus
  periodic snapshots is a complete, replayable record of a session.

## Consequences

- Agents get structured observations. The MCP server exposes the stream directly.
- High-volume events (`fs.change` during `npm install`, syscall traces) need coalescing and sampling
  controls before they are exposed to agents.
- Event schemas are a public API and are versioned like one.
