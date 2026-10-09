# 0019. Workspaces persist /home as object packs in the runtime origin's storage

- **Status:** Accepted · implemented in M2b
- **Date:** 2026-10-09

## Context

ADR-0007 makes snapshots cheap: a directory is a tree hash, and restoring one swaps a pointer.
M2b also needs state to survive a page reload. That means writing objects somewhere durable and
deciding what is persisted, when, by whom, and how storage stays bounded.

The runtime runs on the page's main thread in its own frame (ADR-0017). The browser offers it the
origin private file system (OPFS), IndexedDB, and Web Locks.

## Decision

**A workspace is a name for a persisted `/home`.** Only `/home` is saved. System files
(`/usr/bin`, `/usr/lib/webcore`, `/etc`) are installed fresh at every boot, so a new webcore
version takes effect on the next load. The SDK chooses the workspace (`connect({ workspace })`,
default `"default"`, or `null` for memory only).

**Storage holds packs and records.**
- **Packs:** each save writes one pack holding the objects the store gained since the previous
  save: records of a 32-byte hash, a 32-bit length and the bytes.
- **Records:** a workspace record (`workspaces/<name>.json`) names its head tree and the snapshots
  kept on request.
- **Sharing:** all workspaces in one storage share the objects, so a fork or a copy costs nothing
  until it changes.

**Saving is automatic.** A save follows a change after 1 s of quiet, and at least every 10 s while
changes continue. It snapshots `/home` (only changed files are hashed) and writes the new objects,
then the record. `runtime.snapshot()` saves at once and keeps the result.

**Loading** reads every pack into the in-memory store, then restores the workspace's head (or a
given snapshot) into `/home` as a copy-on-write tree. **Forking** is opening a new workspace
from a snapshot of another one.

**Locks keep writers apart (Web Locks).**
- The first runtime to open a workspace writes it; others load it read-only and say so.
- Every runtime holds a shared lock on the storage while it lives. Compaction needs the lock
  exclusively, so it runs only at a boot when no other runtime is open. It rewrites storage as one
  pack of what records still reach, once storage holds more than 32 packs.

## Consequences

- **Reloading keeps the project, `node_modules` included.** A reload and Vite start again with no
  reinstall. A 5,000-file tree takes 0.2 s to hash the first time and about 10 ms after a change;
  restoring it takes 50 ms.
- **Storage is per embedding site.** Browsers partition a third-party frame's storage by top-level
  site, so each embedding app has its own workspaces. There's no sync across devices. Exporting
  and importing packs would allow that later.
- **Snapshots are not exact copies.** Restoring loses hard links (they become separate files with
  one blob), resets times, and skips devices. Modes and symbolic links are kept.
- **Storage grows with kept snapshots**, which are never dropped yet, and with drafts between
  compactions.
- Browsers may evict storage under pressure. The runtime asks for persistent storage
  (`navigator.storage.persist()`); granting it is up to the browser.

## Alternatives considered

- **A live OPFS-backed filesystem**, with every write going to disk. OPFS's synchronous handles
  exist only in Workers, and the kernel answers synchronous syscalls on the main thread. Every
  write would also pay for I/O that a debounced pack doesn't.
- **One OPFS file per object.** `npm install` would create thousands of files, each costing a
  round trip. Packs make one write per save.
- **IndexedDB.** More overhead per object and per transaction than writing one pack, and no
  benefit for data that is read whole at boot.
