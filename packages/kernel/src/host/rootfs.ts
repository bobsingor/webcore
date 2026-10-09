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
on this browser's JavaScript engine. echo, cat, wc and ls are WASI binaries.
Pipes, files, child processes and exit codes are shared between them.
`

/** Lays out a minimal Unix tree and installs the given WASI binaries into /usr/bin. */
export function installRootfs(kernel: Kernel, binaries: Record<string, Uint8Array>): void {
  const { fs } = kernel
  for (const dir of ['/bin', '/usr/bin', '/home/user', '/tmp', '/etc', '/dev']) fs.mkdirp(dir)
  fs.mknod('/dev/null', 'null')
  // Node needs its standard library, shared with every process as an asset (ADR-0012).
  if (kernel.hasAsset('node-lib')) fs.writeFile('/usr/bin/node', '#!personality:node\n', 0o755)
  for (const [name, bytes] of Object.entries(binaries)) fs.writeFile(`/usr/bin/${name}`, bytes, 0o755)
  fs.writeFile('/etc/motd', MOTD)
  fs.writeFile('/etc/hostname', 'webcore\n')
}
