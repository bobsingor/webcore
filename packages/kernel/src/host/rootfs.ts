import type { Kernel } from '../kernel/kernel.ts'

export const DEFAULT_ENV: Readonly<Record<string, string>> = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/user',
  USER: 'user',
  LANG: 'C.UTF-8',
  TMPDIR: '/tmp',
}

const MOTD = `Welcome to webcore.

Every command is a real process in its own Worker, talking to one kernel through
synchronous syscalls. node is Node.js v24.21.0 — its own standard library, running
on this browser's JavaScript engine. echo, cat, wc and ls are WASI binaries; sh and
npm are webcore's own programs. Pipes, files, sockets, child processes and exit
codes are shared between them.
`

// Read by login shells (sh -l): a colored prompt, then the welcome message.
const PROFILE = `PS1='\\[\\e[1;32m\\]\\u@\\h\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\$ '
cat /etc/motd
`

/** webcore's JavaScript programs (sh, npm): @webcore/userland's dist/userland.json. */
export interface Userland {
  /** Path → content. */
  files: Record<string, string>
  /** Executable → the module it runs (installed as a symbolic link). */
  links: Record<string, string>
}

/**
 * Lays out a minimal Unix tree, installs the given WASI binaries into /usr/bin, and, given the
 * userland bundle, sh and npm.
 */
export function installRootfs(kernel: Kernel, binaries: Record<string, Uint8Array>, userland?: Userland): void {
  const { fs } = kernel
  for (const dir of ['/bin', '/usr/bin', '/home/user', '/tmp', '/etc', '/dev']) fs.mkdirp(dir)
  fs.mknod('/dev/null', 'null')
  // Node needs its standard library, shared with every process as an asset (ADR-0012).
  if (kernel.hasAsset('node-lib')) fs.writeFile('/usr/bin/node', '#!personality:node\n', 0o755)
  for (const [name, bytes] of Object.entries(binaries)) fs.writeFile(`/usr/bin/${name}`, bytes, 0o755)
  if (userland) {
    const executables = new Set(Object.values(userland.links))
    for (const [path, content] of Object.entries(userland.files)) {
      fs.mkdirp(path.slice(0, path.lastIndexOf('/')) || '/')
      fs.writeFile(path, content, executables.has(path) ? 0o755 : 0o644)
    }
    for (const [path, target] of Object.entries(userland.links)) {
      if (fs.tryLookup(path, false)) fs.unlink(path)
      fs.symlink(target, path)
    }
  }
  fs.writeFile('/etc/motd', MOTD)
  fs.writeFile('/etc/profile', PROFILE)
  fs.writeFile('/etc/hostname', 'webcore\n')
}
