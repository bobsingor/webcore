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
on this browser's JavaScript engine. sh is BusyBox's hush, and ls, grep, sed, awk,
vi, less and a hundred more are BusyBox too: C compiled to WebAssembly (WASIX).
Pipes, files, signals, job control (Ctrl+Z, fg, bg) and exit codes work across
all of them.
`

// Read by login shells (sh -l): a colored prompt, then the welcome message.
const PROFILE = `PS1='\\[\\e[1;32m\\]\\u@\\h\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\$ '
cat /etc/motd
`

// One user, who owns every file (WASIX programs and Node agree on uid 1000).
const PASSWD = `root:x:0:0:root:/root:/bin/sh
user:x:1000:1000:user:/home/user:/bin/sh
`
const GROUP = `root:x:0:
user:x:1000:
`

/** webcore's JavaScript programs (npm, npx): @webcore/userland's dist/userland.json. */
export interface Userland {
  /** Path → content. */
  files: Record<string, string>
  /** Executable → the module it runs (installed as a symbolic link). */
  links: Record<string, string>
}

export interface RootfsOptions {
  /**
   * BusyBox (@webcore/wasix-bin): installed as /bin/busybox, with a symbolic link for each applet
   * in `links` (busybox.links: /bin/sh, /bin/ls, /usr/bin/awk, …). Its hush is /bin/sh.
   */
  busybox?: { binary: Uint8Array; links: string[] }
  /** More programs (WASI or WASIX binaries), installed into /usr/bin by name. */
  programs?: Record<string, Uint8Array>
  userland?: Userland
}

/** Lays out a minimal Unix tree with BusyBox, Node (when its library is an asset) and npm. */
export function installRootfs(kernel: Kernel, options: RootfsOptions = {}): void {
  const { fs } = kernel
  for (const dir of ['/bin', '/usr/bin', '/home/user', '/root', '/tmp', '/etc', '/dev']) fs.mkdirp(dir)
  fs.mknod('/dev/null', 'null')
  if (options.busybox) {
    fs.writeFile('/bin/busybox', options.busybox.binary, 0o755)
    for (const path of options.busybox.links) {
      if (!path.startsWith('/') || path === '/bin/busybox') continue
      fs.mkdirp(path.slice(0, path.lastIndexOf('/')) || '/')
      fs.symlink('/bin/busybox', path)
    }
  }
  // Node needs its standard library, shared with every process as an asset (ADR-0012).
  if (kernel.hasAsset('node-lib')) fs.writeFile('/usr/bin/node', '#!personality:node\n', 0o755)
  for (const [name, bytes] of Object.entries(options.programs ?? {})) {
    // A program replaces an applet's link of the same name rather than writing through it.
    if (fs.tryLookup(`/usr/bin/${name}`, false)?.kind === 'symlink') fs.unlink(`/usr/bin/${name}`)
    fs.writeFile(`/usr/bin/${name}`, bytes, 0o755)
  }
  if (options.userland) {
    const executables = new Set(Object.values(options.userland.links))
    for (const [path, content] of Object.entries(options.userland.files)) {
      fs.mkdirp(path.slice(0, path.lastIndexOf('/')) || '/')
      fs.writeFile(path, content, executables.has(path) ? 0o755 : 0o644)
    }
    for (const [path, target] of Object.entries(options.userland.links)) {
      if (fs.tryLookup(path, false)) fs.unlink(path)
      fs.symlink(target, path)
    }
  }
  fs.writeFile('/etc/motd', MOTD)
  fs.writeFile('/etc/profile', PROFILE)
  fs.writeFile('/etc/hostname', 'webcore\n')
  fs.writeFile('/etc/passwd', PASSWD)
  fs.writeFile('/etc/group', GROUP)
}

/** busybox.links (one path per line) as RootfsOptions' links. */
export function busyboxLinks(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
}
