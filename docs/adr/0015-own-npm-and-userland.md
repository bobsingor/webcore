# 0015. npm and sh are webcore programs; the kernel unpacks packages

- **Status:** Accepted · implemented in M1d
- **Date:** 2026-10-09

## Context

M1's exit criterion starts with `npm create vite@latest` and `npm install`, and `npm run dev` runs
its script through `sh -c`. There are three options for `npm`:

1. **Run the npm CLI.** It is a large program that downloads through Node's `https` module. That
   needs TLS sockets and OpenSSL-backed crypto, which webcore doesn't have. npm also runs every
   dependency's install scripts, which often build native code or download platform binaries.
2. **A host-side installer.** Fast, but it would be invisible to the kernel: not a process, no
   events, not callable from a script or `child_process`.
3. **An installer of our own, running as a process on webcore's Node.** It has npm's command line
   and npm's on-disk results, and it can ask the kernel for help where Node has no suitable API.

Unpacking is the expensive part. A package manager written against Node's API spends three
syscalls per file, and a typical React template installs about 2,000 files.

## Decision

Option 3, plus a kernel primitive for unpacking.

**Userland.** `@webcore/userland` holds webcore's own programs. They are TypeScript, stripped to
JavaScript at build time and installed under `/usr/lib/webcore`, and `/bin/sh`, `/usr/bin/npm` and
`/usr/bin/npx` are symlinks to them (the VFS now has symbolic links). Programs reach the kernel ABI
through `process.webcore.syscall()`, which is non-enumerable so Node code doesn't see it.

**npm.** Our npm implements `install`/`ci`/`uninstall`, `run` (with pre and post scripts),
`exec`/`npx` and `init`/`create`. It produces what npm 11 produces:
- **Layout:** a hoisted `node_modules`. Each dependency reuses a visible copy that satisfies it;
  otherwise it is placed as high as it can go without changing what another package resolves.
  Peers are placed where their dependent's parent can see them.
- **Lockfile:** `package-lock.json` v3. A lockfile that still satisfies `package.json` is
  installed as-is, without asking the registry.
- **Bins:** `node_modules/.bin` symlinks.
- **Scripts:** run with npm's environment and `node_modules/.bin` on `PATH`.

For the React template it resolves the same versions as npm itself.

**The registry** is reached with the host's `fetch`, so it must allow CORS (registry.npmjs.org
does). Each tarball starts downloading as soon as its package is placed in the tree.

**`extract` syscall.** One call unpacks a gzipped tarball into a directory. It checks the
Subresource Integrity hash with WebCrypto, gunzips natively with `DecompressionStream`, and writes
the files straight into the VFS.

**Platform `linux`/`wasm32`.** Optional dependencies named like native binaries for another
platform (`pkg-linux-x64-gnu`, `@scope/darwin-arm64`) are skipped without fetching them. When a
package has those, its napi-rs `-wasm32-wasi` build is installed in their place. This is ADR-0006's
substitution for the napi-rs ecosystem (Rolldown, oxc, Tailwind's oxide).

**Scripts.** Dependencies' install scripts are skipped and listed, as pnpm does by default. The
root project's lifecycle scripts run.

**`sh`.** `/bin/sh` is a POSIX-subset shell that runs commands on kernel pipes and `spawn` with
explicit fds:
- **Language:** lists, pipelines, redirections, quoting, parameter and command substitution,
  `if`/`for`/`while`, and globbing.
- **Builtins:** a few file utilities (`rm`, `mkdir`, `cp`, `mv`, `touch`) stand in for coreutils.
- **Process groups:** the kernel now has them. Ctrl+C reaches a whole job (`npm` → `sh` →
  `vite`), and `kill(-pgid)` works.

## Consequences

- `npm create vite` and `npm install` work in the browser in a few seconds, without a TLS stack.
- **It reports itself as npm 11.6.2** (`npm_config_user_agent`), because tools read that string
  to decide which commands to print. It is not npm. Features outside the list above (publishing,
  workspaces, `git:` and `file:` specs, global installs) fail with a clear message.
- **Lockfiles differ from npm's.** They omit other platforms' optional packages and include the
  wasm32-wasi substitutes. Moving a project between webcore and a real machine re-resolves those
  entries.
- **Packages that need their install scripts are installed without them.** Running scripts
  safely (an allow-list, as pnpm does) is a follow-up.
- **The kernel gains three general features:** symbolic and hard links, process groups, and
  `extract`. With ADR-0007's content-addressed store, `extract` can later mount a package instead
  of copying it, without changing callers.
