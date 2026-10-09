# 0007. Content-addressed, copy-on-write VFS; snapshots are tree hashes

- **Status:** Accepted (M0 uses a plain memfs behind the same interface)
- **Date:** 2026-10-09

## Context

Several features we want depend on cheap filesystem snapshots:

- environment fork and restore for agents (try something, roll back)
- instant boot from a pre-installed template
- deduplicated `node_modules` across projects
- replay and "open this tutorial moment in the IDE"

Retrofitting snapshots onto a mutable in-place filesystem means a rewrite of the VFS and every backend.

## Decision

- File contents are stored as immutable blobs addressed by hash. Directories are trees of
  `name → (mode, hash)`, as in git.
- Writable state is a copy-on-write layer over immutable trees. Writes go to the upper layer, and
  reads fall through.
- A snapshot is a manifest of root tree hashes. Restoring one is a pointer swap.
- Backends (memory, OPFS, IndexedDB, lazy-HTTP) store blobs and trees. The mount table composes them.
- Hashing is deferred and incremental: files are hashed when a snapshot is taken, not on every write.

## Consequences

- Snapshot, fork and restore are cheap, and storage deduplicates for free.
- Templates and runtime images can be served as static, cacheable, content-addressed bundles from any
  CDN.
- More complexity than a plain memfs. M0 implements a plain memfs behind the VFS interface. The CoW
  store lands in M2, before anything depends on in-place mutation semantics.
