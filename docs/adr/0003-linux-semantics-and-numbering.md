# 0003. Kernel ABI follows Linux semantics, flags and errno numbering

- **Status:** Accepted · implemented in M0
- **Date:** 2026-10-09

## Context

Each guest ABI has its own conventions. WASI numbers `ENOENT` as 44, Linux uses 2, and Node exposes
the string `'ENOENT'`. Open flags, seek whence values and file types also differ. The kernel needs one
canonical vocabulary.

Nearly all software we want to run (npm, Python, Postgres, bash, git) was written for Linux and probes
for Linux behaviour.

## Decision

- Kernel syscalls follow Linux semantics: `open`/`openat` flags (`O_CREAT` = `0o100`, …), `lseek`
  whence, `AT_FDCWD` = −100, stat modes, pipe and EOF behaviour, and lowest-free-fd allocation.
- Errno values on the wire are Linux numbers (`ENOENT` = 2, `EBADF` = 9, `EPIPE` = 32, …).
- Personalities translate at the boundary. The WASI personality maps to WASI errno values. The Node
  personality builds Node-style errors with `.code`, `.errno`, `.syscall` and `.path`.
- The process environment reports itself as Linux (`process.platform === 'linux'`).
- File descriptors 0, 1 and 2 always exist in a new process (`/dev/null` if not provided), so
  numbering of later descriptors such as WASI preopens is predictable.

## Consequences

- WASIX (whose API is itself Linux-derived) maps almost one-to-one.
- A future emulation backend running real Linux binaries can forward syscalls with minimal
  translation.
- Translation tables in each personality must be kept complete. Unmapped errors fall back to `EIO`.
