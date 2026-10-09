import type { Kernel } from '../kernel/kernel.ts'

export const DEFAULT_ENV: Readonly<Record<string, string>> = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/user',
  USER: 'user',
  LANG: 'C.UTF-8',
  TMPDIR: '/tmp',
}

const MOTD = `Welcome to webcore — M0 kernel spike.

Every command here is a real process in its own Worker, talking to one kernel
through synchronous syscalls. node runs JavaScript on the browser's own engine;
echo, cat, wc and ls are WASI binaries. Pipes, files and exit codes are shared.
`

/** Lays out a minimal Unix tree and installs the given WASI binaries into /usr/bin. */
export function installRootfs(kernel: Kernel, binaries: Record<string, Uint8Array>): void {
  const { fs } = kernel
  for (const dir of ['/bin', '/usr/bin', '/home/user', '/tmp', '/etc', '/dev']) fs.mkdirp(dir)
  fs.mknod('/dev/null', 'null')
  fs.writeFile('/usr/bin/node', '#!personality:node\n', 0o755)
  for (const [name, bytes] of Object.entries(binaries)) fs.writeFile(`/usr/bin/${name}`, bytes, 0o755)
  fs.writeFile('/etc/motd', MOTD)
  fs.writeFile('/etc/hostname', 'webcore\n')
}
