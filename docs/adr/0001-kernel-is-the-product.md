# 0001. The kernel and its syscall ABI are the product; runtimes are packages

- **Status:** Accepted
- **Date:** 2026-10-09

## Context

The goal is many languages and databases in the browser. There are two ways to get there:

1. **Per-runtime emulators.** Build a Node emulator, then a Python integration, then a PHP
   integration, each with its own filesystem, process model and networking.
2. **One kernel.** Every runtime is an executable that talks to the same kernel through the same
   syscall interface.

Option 1 is how most browser runtimes started. It doesn't compose: Node can't spawn Python, Python
can't read files Node wrote, and a database can't listen on a port that both can reach.

## Decision

Build a kernel. It owns processes, file descriptors, pipes, the VFS, the network and the event log.
Languages and databases are executables in the filesystem (`/usr/bin/node`, `/usr/bin/python3`,
`/usr/bin/postgres`), resolved through `PATH` like on any Unix system.

"Supporting Postgres" therefore means "Postgres runs as a process and listens on a socket". It does
not mean "we wrote a Postgres integration".

## Consequences

- Cross-language composition is free: pipes, shared files, `child_process`, sockets.
- Every runtime we add is a test of the kernel's generality. A second, very different runtime must
  arrive early (M3) so the kernel does not quietly become Node-shaped.
- The kernel ABI is the most important interface in the project and needs versioning discipline.
- More up-front work than a Node-only emulator before the first impressive demo.

## Alternatives considered

- **Node-only emulator first, generalize later.** Faster to a demo. Retrofitting a process model and
  shared VFS under an existing emulator is effectively a rewrite.
- **CPU emulation (x86 Linux in Wasm).** Maximum compatibility, but 5–20× slower, large downloads, and
  the best implementation (CheerpX) is proprietary. Kept as an optional backend for the long tail.
