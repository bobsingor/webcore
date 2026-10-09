// WASIX (wasix_32v1) and webcore's own `webcore` imports, on kernel syscalls (ADR-0020).
//
// WASIX adds processes, pipes, fd duplication, signals and a terminal to preview1. A program runs
// as its vfork child from proc_fork_env until proc_exec4 or proc_exit2: the kernel applies the
// thread's syscalls to the child meanwhile, and both calls return here so that libc can longjmp
// back to vfork in the parent.
//
// The `webcore` imports come from libwebcore, which programs webcore builds link: the Linux calls
// that wasix-libc otherwise answers from the program's own memory (process groups, sessions,
// termios, the terminal's foreground group, file modes, signal dispositions). They return a
// result, or a negative errno in WASI's numbering.
import { AT_FDCWD, type Stat } from '../../abi/constants.ts'
import { Errno } from '../../abi/errno.ts'
import {
  ECHO,
  ICANON,
  IGNCR,
  NCCS,
  TCGETS,
  TCSETS,
  TIOCGPGRP,
  TIOCGWINSZ,
  TIOCSPGRP,
  TIOCSWINSZ,
  WNOHANG,
  WUNTRACED,
  type SignalAction,
  type Termios,
  type WinSize,
} from '../../abi/signals.ts'
import { park } from '../../abi/page.ts'
import { SysError, type SyscallClient } from '../../process/syscalls.ts'
import { decodeBytes } from './bytes.ts'
import { openFlags, wasiErrno, WASI_ENOSYS, type Fds, type Imports } from './preview1.ts'

const WASI_EPERM = 63

const SPAWN_CLOSE = 0
const SPAWN_DUP2 = 1
const SPAWN_OPEN = 2
const SPAWN_CHDIR = 3

const JOIN_NOTHING = 0
const JOIN_EXIT_NORMAL = 1
const JOIN_EXIT_SIGNAL = 2
const JOIN_STOPPED = 3

/** struct termios on wasm32: four flags, c_line, c_cc[32], two speeds. */
const TERMIOS_CC = 17

const DISPOSITIONS: SignalAction[] = ['default', 'ignore', 'handle']

export interface WasixProcess {
  sys: SyscallClient
  fds: Fds
  page: SharedArrayBuffer
  memory(): WebAssembly.Memory
  guard(fn: () => void): number
  /** The pid the program is now: its own, or that of the vfork child it runs as. */
  pid(): number
  ppid(): number
  /** vfork children the program runs as, innermost last. */
  vforks: { pid: number; ppid: number }[]
  /** Signals the program starts out ignoring (inherited through exec). */
  ignored: number[]
  env: Record<string, string>
  /** The export libc registered to receive signals. */
  onSignalCallback(name: string): void
  /** Sleeps up to `ms`; false when a signal for a handler cut it short. */
  sleep(ms: number): boolean
  exit(code: number): never
  /** The last stat a filestat call returned. */
  lastStat(): Stat | undefined
}

export function wasixImports(proc: WasixProcess): { wasix_32v1: Imports; webcore: Imports } {
  const { sys, fds, guard } = proc
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const view = () => new DataView(proc.memory().buffer)
  const bytes = () => new Uint8Array(proc.memory().buffer)
  const readString = (ptr: number, len: number) => decoder.decode(bytes().slice(ptr, ptr + len))
  const readCString = (ptr: number) => {
    const memory = bytes()
    const end = memory.indexOf(0, ptr)
    return decodeBytes(memory.slice(ptr, end < 0 ? memory.length : end))
  }
  /** A `cstring_array`: `count` pointers to NUL-terminated strings. */
  const readCStrings = (ptr: number, count: number) => {
    const dv = view()
    return Array.from({ length: count }, (_, i) => readCString(dv.getUint32(ptr + i * 4, true)))
  }
  const environment = (ptr: number, count: number): Record<string, string> => {
    if (!ptr) return { ...proc.env }
    const env: Record<string, string> = {}
    for (const entry of readCStrings(ptr, count)) {
      const eq = entry.indexOf('=')
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
    return env
  }

  /** The terminal behind stdin, stdout or stderr: WASIX's tty calls name no fd. */
  const isTerminal = (fd: number) => {
    try {
      sys.call('ioctl', fd, TCGETS)
      return true
    } catch {
      return false
    }
  }
  const terminal = () => {
    const fd = [0, 1, 2].find(isTerminal)
    if (fd === undefined) throw new SysError(Errno.ENOTTY, 'tty')
    return fd
  }

  /** execve as the vfork child or the program itself; the latter never returns. */
  const exec = (file: string, argv: string[], env: Record<string, string>, search: string | undefined) => {
    sys.call('execve', file, argv, env, search)
    if (proc.vforks.length) {
      proc.vforks.pop()
      return
    }
    // The kernel ends this Worker; nothing of the old program may run meanwhile.
    park(proc.page)
  }

  /** A webcore import: the result, or a negative errno. */
  const linux = (fn: () => number): number => {
    try {
      return fn()
    } catch (error) {
      if (error instanceof SysError) return -wasiErrno(error.errno)
      throw error
    }
  }

  const readTermios = (ptr: number): Termios => {
    const dv = view()
    const cc = Array.from(bytes().slice(ptr + TERMIOS_CC, ptr + TERMIOS_CC + NCCS))
    return { iflag: dv.getUint32(ptr, true), oflag: dv.getUint32(ptr + 4, true), cflag: dv.getUint32(ptr + 8, true), lflag: dv.getUint32(ptr + 12, true), cc }
  }
  const writeTermios = (ptr: number, termios: Termios) => {
    const dv = view()
    dv.setUint32(ptr, termios.iflag, true)
    dv.setUint32(ptr + 4, termios.oflag, true)
    dv.setUint32(ptr + 8, termios.cflag, true)
    dv.setUint32(ptr + 12, termios.lflag, true)
    const cc = new Uint8Array(33)
    cc.set(termios.cc.slice(0, 32), 1)
    bytes().set(cc, ptr + 16)
    dv.setUint32(ptr + 52, 0, true)
    dv.setUint32(ptr + 56, 0, true)
  }

  const wasix: Imports = {
    fd_dup: (fd: number, retPtr: number) => guard(() => view().setUint32(retPtr, sys.call('dup', fds.kernel(fd), 0, false), true)),
    fd_dup2: (fd: number, min: number, cloexec: number, retPtr: number) =>
      guard(() => view().setUint32(retPtr, sys.call('dup', fds.kernel(fd), min, cloexec !== 0), true)),
    fd_fdflags_get: (fd: number, retPtr: number) => guard(() => view().setUint16(retPtr, sys.call('fdflags', fds.kernel(fd)), true)),
    fd_fdflags_set: (fd: number, flags: number) => guard(() => sys.call('fdflags', fds.kernel(fd), (flags & 1) !== 0)),
    fd_pipe: (readPtr: number, writePtr: number) =>
      guard(() => {
        const [read, write] = sys.call('pipe')
        view().setUint32(readPtr, fds.add(read), true)
        view().setUint32(writePtr, fds.add(write), true)
      }),

    getcwd: (ptr: number, lenPtr: number) =>
      guard(() => {
        const cwd = encoder.encode(`${sys.call('getcwd')}\0`)
        const room = view().getUint32(lenPtr, true)
        view().setUint32(lenPtr, cwd.length, true)
        if (!ptr || room < cwd.length) throw new SysError(Errno.ERANGE, 'getcwd')
        bytes().set(cwd, ptr)
      }),
    chdir: (ptr: number, len: number) => guard(() => sys.call('chdir', readString(ptr, len))),

    callback_signal: (ptr: number, len: number) => {
      proc.onSignalCallback(readString(ptr, len))
    },
    thread_id: (retPtr: number) => (view().setUint32(retPtr, 1, true), 0),
    thread_parallelism: (retPtr: number) => (view().setUint32(retPtr, 1, true), 0),
    // raise(): the calling thread is the process.
    thread_signal: (_tid: number, signal: number) => guard(() => sys.call('kill', proc.pid(), signal)),
    thread_sleep: (duration: bigint) =>
      guard(() => {
        if (!proc.sleep(Number(duration) / 1e6)) throw new SysError(Errno.EINTR, 'thread_sleep')
      }),

    futex_wait: (ptr: number, expected: number, timeoutPtr: number, retPtr: number) => {
      const dv = view()
      const timeout = timeoutPtr && dv.getUint8(timeoutPtr) ? Number(dv.getBigUint64(timeoutPtr + 8, true)) / 1e6 : Infinity
      const result = Atomics.wait(new Int32Array(proc.memory().buffer), ptr >>> 2, expected, timeout)
      dv.setUint8(retPtr, result === 'timed-out' ? 0 : 1)
      return 0
    },
    futex_wake: (ptr: number, retPtr: number) => {
      view().setUint8(retPtr, Atomics.notify(new Int32Array(proc.memory().buffer), ptr >>> 2, 1) > 0 ? 1 : 0)
      return 0
    },
    futex_wake_all: (ptr: number, retPtr: number) => {
      view().setUint8(retPtr, Atomics.notify(new Int32Array(proc.memory().buffer), ptr >>> 2) > 0 ? 1 : 0)
      return 0
    },

    proc_id: (retPtr: number) => (view().setUint32(retPtr, proc.pid(), true), 0),
    proc_parent: (pid: number, retPtr: number) =>
      guard(() => {
        if (pid !== proc.pid()) throw new SysError(Errno.ESRCH, 'proc_parent')
        view().setUint32(retPtr, proc.ppid(), true)
      }),

    proc_fork_env: (pidPtr: number) =>
      guard(() => {
        const parent = proc.pid()
        const child = sys.call('vfork')
        proc.vforks.push({ pid: child, ppid: parent })
        view().setUint32(pidPtr, child, true)
      }),
    proc_exit2: (code: number) => {
      if (!proc.vforks.length) proc.exit(code)
      sys.call('vforkExit', code)
      proc.vforks.pop()
    },
    proc_exec4: (
      namePtr: number,
      nameLen: number,
      argsPtr: number,
      argsLen: number,
      envsPtr: number,
      envsLen: number,
      search: number,
      pathPtr: number,
      pathLen: number,
    ) =>
      guard(() =>
        exec(readString(namePtr, nameLen), readCStrings(argsPtr, argsLen), environment(envsPtr, envsLen), search ? readString(pathPtr, pathLen) : undefined),
      ),
    // posix_spawn: vfork, the file actions and signal defaults in the child, then exec.
    proc_spawn3: (
      namePtr: number,
      nameLen: number,
      argsPtr: number,
      argsLen: number,
      envsPtr: number,
      envsLen: number,
      opsPtr: number,
      opsLen: number,
      signalsPtr: number,
      signalsLen: number,
      search: number,
      pathPtr: number,
      pathLen: number,
      pidPtr: number,
    ) =>
      guard(() => {
        const file = readString(namePtr, nameLen)
        const argv = readCStrings(argsPtr, argsLen)
        const env = environment(envsPtr, envsLen)
        const parent = proc.pid()
        const child = sys.call('vfork')
        proc.vforks.push({ pid: child, ppid: parent })
        try {
          const dv = view()
          for (let i = 0; i < opsLen; i++) {
            const op = opsPtr + i * 56
            const fd = dv.getUint32(op + 4, true)
            const path = () => readString(dv.getUint32(op + 12, true), dv.getUint32(op + 16, true))
            switch (dv.getUint8(op)) {
              case SPAWN_CLOSE:
                try {
                  sys.call('close', fd)
                } catch {
                  // Closing what isn't open is no failure.
                }
                break
              case SPAWN_DUP2: {
                const source = dv.getUint32(op + 8, true)
                if (source === fd) sys.call('fdflags', fd, false)
                else sys.call('dup2', source, fd)
                break
              }
              case SPAWN_OPEN: {
                const flags = openFlags(dv.getUint16(op + 24, true), dv.getBigUint64(op + 32, true), dv.getUint16(op + 48, true))
                const opened = sys.call('open', path(), flags, 0o666, AT_FDCWD)
                if (opened !== fd) {
                  sys.call('dup2', opened, fd)
                  sys.call('close', opened)
                }
                break
              }
              case SPAWN_CHDIR:
                sys.call('chdir', path())
                break
              default:
                throw new SysError(Errno.ENOSYS, 'proc_spawn3')
            }
          }
          for (let i = 0; i < signalsLen; i++) {
            const entry = signalsPtr + i * 2
            sys.call('sigaction', dv.getUint8(entry), dv.getUint8(entry + 1) === 1 ? 'ignore' : 'default')
          }
          exec(file, argv, env, search ? readString(pathPtr, pathLen) : undefined)
        } catch (error) {
          sys.call('vforkExit', 127)
          proc.vforks.pop()
          throw error
        }
        view().setUint32(pidPtr, child, true)
      }),
    proc_join: (pidPtr: number, flags: number, statusPtr: number) =>
      guard(() => {
        const dv = view()
        const pid = dv.getUint8(pidPtr) ? dv.getInt32(pidPtr + 4, true) : -1
        const [child, status] = sys.call('wait4', pid, (flags & 1 ? WNOHANG : 0) | (flags & 2 ? WUNTRACED : 0))
        dv.setUint8(pidPtr, 1)
        dv.setUint32(pidPtr + 4, child, true)
        new Uint8Array(proc.memory().buffer, statusPtr, 6).fill(0)
        if (!child) dv.setUint8(statusPtr, JOIN_NOTHING)
        else if ((status & 0xff) === 0x7f) {
          dv.setUint8(statusPtr, JOIN_STOPPED)
          dv.setUint8(statusPtr + 2, (status >> 8) & 0xff)
        } else if (status & 0x7f) {
          dv.setUint8(statusPtr, JOIN_EXIT_SIGNAL)
          dv.setUint8(statusPtr + 4, status & 0x7f)
        } else {
          dv.setUint8(statusPtr, JOIN_EXIT_NORMAL)
          dv.setUint16(statusPtr + 2, (status >> 8) & 0xff, true)
        }
      }),
    proc_signal: (pid: number, signal: number) => guard(() => sys.call('kill', pid, signal)),
    proc_signals_sizes_get: (retPtr: number) => (view().setUint32(retPtr, proc.ignored.length, true), 0),
    proc_signals_get: (ptr: number) => {
      proc.ignored.forEach((signal, i) => {
        view().setUint8(ptr + i * 2, signal)
        view().setUint8(ptr + i * 2 + 1, 1)
      })
      return 0
    },

    tty_get: (ptr: number) =>
      guard(() => {
        const fd = terminal()
        const termios = sys.call('ioctl', fd, TCGETS) as Termios
        const size = sys.call('ioctl', fd, TIOCGWINSZ) as WinSize
        const dv = view()
        dv.setUint32(ptr, size.cols, true)
        dv.setUint32(ptr + 4, size.rows, true)
        dv.setUint32(ptr + 8, 0, true)
        dv.setUint32(ptr + 12, 0, true)
        ;[0, 1, 2].forEach((stdio) => dv.setUint8(ptr + 16 + stdio, isTerminal(stdio) ? 1 : 0))
        dv.setUint8(ptr + 19, termios.lflag & ECHO ? 1 : 0)
        dv.setUint8(ptr + 20, termios.lflag & ICANON ? 1 : 0)
        dv.setUint8(ptr + 21, termios.iflag & IGNCR ? 1 : 0)
      }),
    tty_set: (ptr: number) =>
      guard(() => {
        const fd = terminal()
        const dv = view()
        const termios = sys.call('ioctl', fd, TCGETS) as Termios
        const set = (flags: number, bit: number, on: boolean) => (on ? flags | bit : flags & ~bit)
        termios.lflag = set(set(termios.lflag, ECHO, dv.getUint8(ptr + 19) !== 0), ICANON, dv.getUint8(ptr + 20) !== 0)
        termios.iflag = set(termios.iflag, IGNCR, dv.getUint8(ptr + 21) !== 0)
        sys.call('ioctl', fd, TCSETS, termios)
        const cols = dv.getUint32(ptr, true)
        const rows = dv.getUint32(ptr + 4, true)
        const size = sys.call('ioctl', fd, TIOCGWINSZ) as WinSize
        if (cols && rows && (cols !== size.cols || rows !== size.rows)) sys.call('ioctl', fd, TIOCSWINSZ, { cols, rows })
      }),

    clock_time_set: () => WASI_EPERM,
    proc_fork: () => WASI_ENOSYS,
  }

  const webcore: Imports = {
    sigaction: (signal: number, disposition: number, restart: number) =>
      linux(() => {
        const action = DISPOSITIONS[disposition]
        if (!action) throw new SysError(Errno.EINVAL, 'sigaction')
        sys.call('sigaction', signal, action, restart !== 0)
        // A vfork child shares its parent's memory: libc must leave the parent's handlers be.
        return proc.vforks.length ? 1 : 0
      }),
    pause: () => linux(() => sys.call('pause')),
    kill: (pid: number, signal: number) => linux(() => sys.call('kill', pid, signal)),
    wait4: (pid: number, statusPtr: number, options: number) =>
      linux(() => {
        const [child, status] = sys.call('wait4', pid, options)
        if (child) view().setInt32(statusPtr, status, true)
        return child
      }),
    umask: (mask: number) => linux(() => sys.call('umask', mask)),
    utimes: (dirfd: number, pathPtr: number, atime: number, mtime: number, follow: number) =>
      linux(() => {
        const now = Date.now()
        const time = (ms: number) => (Number.isNaN(ms) ? null : ms === Infinity ? now : ms)
        if (!pathPtr) return sys.call('utimes', null, time(atime), time(mtime), fds.kernel(dirfd))
        const [at, path] = dirfd < 0 ? [AT_FDCWD, readCString(pathPtr)] : fds.at(dirfd, readCString(pathPtr))
        return sys.call('utimes', path, time(atime), time(mtime), at, follow !== 0)
      }),
    setpgid: (pid: number, pgid: number) => linux(() => sys.call('setpgid', pid, pgid)),
    getpgid: (pid: number) => linux(() => sys.call('getpgid', pid)),
    setsid: () => linux(() => sys.call('setsid')),
    getsid: (pid: number) => linux(() => sys.call('getsid', pid)),
    tcgetpgrp: (fd: number) => linux(() => sys.call('ioctl', fds.kernel(fd), TIOCGPGRP) as number),
    tcsetpgrp: (fd: number, pgrp: number) => linux(() => (sys.call('ioctl', fds.kernel(fd), TIOCSPGRP, pgrp), 0)),
    tcgetattr: (fd: number, ptr: number) => linux(() => (writeTermios(ptr, sys.call('ioctl', fds.kernel(fd), TCGETS) as Termios), 0)),
    tcsetattr: (fd: number, act: number, ptr: number) => linux(() => (sys.call('ioctl', fds.kernel(fd), TCSETS + act, readTermios(ptr)), 0)),
    stat_mode: () => (proc.lastStat()?.mode ?? 0) & 0o7777,
    chmod: (dirfd: number, pathPtr: number, mode: number) =>
      linux(() => {
        if (!pathPtr) return sys.call('chmod', null, mode, fds.kernel(dirfd))
        const [at, path] = dirfd < 0 ? [AT_FDCWD, readCString(pathPtr)] : fds.at(dirfd, readCString(pathPtr))
        return sys.call('chmod', path, mode, at)
      }),
  }

  return { wasix_32v1: wasix, webcore }
}
