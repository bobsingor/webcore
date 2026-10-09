// Signals, in Linux's numbering (ADR-0003). A process chooses, per signal, the default action,
// ignoring it, or handling it. Handled signals reach a Node process over its message port, and a
// WASI process between syscalls (ADR-0020).

export const SIGHUP = 1
export const SIGINT = 2
export const SIGQUIT = 3
export const SIGKILL = 9
export const SIGPIPE = 13
export const SIGTERM = 15
export const SIGCHLD = 17
export const SIGCONT = 18
export const SIGSTOP = 19
export const SIGTSTP = 20
export const SIGTTIN = 21
export const SIGTTOU = 22
export const SIGWINCH = 28

export const SIGNAL_NAMES: Record<number, string> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  4: 'SIGILL',
  5: 'SIGTRAP',
  6: 'SIGABRT',
  7: 'SIGBUS',
  8: 'SIGFPE',
  9: 'SIGKILL',
  10: 'SIGUSR1',
  11: 'SIGSEGV',
  12: 'SIGUSR2',
  13: 'SIGPIPE',
  14: 'SIGALRM',
  15: 'SIGTERM',
  16: 'SIGSTKFLT',
  17: 'SIGCHLD',
  18: 'SIGCONT',
  19: 'SIGSTOP',
  20: 'SIGTSTP',
  21: 'SIGTTIN',
  22: 'SIGTTOU',
  23: 'SIGURG',
  24: 'SIGXCPU',
  25: 'SIGXFSZ',
  26: 'SIGVTALRM',
  27: 'SIGPROF',
  28: 'SIGWINCH',
  29: 'SIGIO',
  30: 'SIGPWR',
  31: 'SIGSYS',
}

/** Signals whose default action is to do nothing. */
const IGNORED_BY_DEFAULT = new Set([SIGCHLD, SIGCONT, 23 /* SIGURG */, SIGWINCH])

/** Signals whose default action stops the process (job control). */
const STOP_BY_DEFAULT = new Set([SIGSTOP, SIGTSTP, SIGTTIN, SIGTTOU])

export type SignalAction = 'default' | 'ignore' | 'handle'

/** Whether the default action of `signal` terminates the process. */
export function defaultTerminates(signal: number): boolean {
  return !IGNORED_BY_DEFAULT.has(signal) && !STOP_BY_DEFAULT.has(signal)
}

/** Whether the default action of `signal` stops the process. */
export function defaultStops(signal: number): boolean {
  return STOP_BY_DEFAULT.has(signal)
}

export function isValidSignal(signal: number): boolean {
  return Number.isInteger(signal) && signal >= 1 && signal <= 64
}

/** Kernel → process: a signal the process handles. */
export interface SignalMessage {
  t: 'sig'
  signal: number
}

// --- terminals ---------------------------------------------------------------------------------

/** struct termios, as the ioctl syscall carries it. */
export interface Termios {
  iflag: number
  oflag: number
  cflag: number
  lflag: number
  /** Control characters, indexed by VINTR…VEOL2. */
  cc: number[]
}

/** struct winsize. */
export interface WinSize {
  rows: number
  cols: number
}

// wait4 options and status encoding (as Linux's)
export const WNOHANG = 1
export const WUNTRACED = 2
export const WCONTINUED = 8

/** A wait status: exited with `code`, killed by `signal`, stopped by `stopped`, or continued. */
export function waitStatus(state: { code?: number; signal?: number; stopped?: number; continued?: boolean }): number {
  if (state.continued) return 0xffff
  if (state.stopped !== undefined) return ((state.stopped & 0xff) << 8) | 0x7f
  if (state.signal !== undefined) return state.signal & 0x7f
  return ((state.code ?? 0) & 0xff) << 8
}

// ioctl requests (asm-generic/ioctls.h)
export const TCGETS = 0x5401
export const TCSETS = 0x5402
export const TCSETSW = 0x5403
export const TCSETSF = 0x5404
export const TIOCSCTTY = 0x540e
export const TIOCGPGRP = 0x540f
export const TIOCSPGRP = 0x5410
export const TIOCGWINSZ = 0x5413
export const TIOCSWINSZ = 0x5414
export const FIONREAD = 0x541b
export const TIOCGSID = 0x5429

// c_iflag
export const ISTRIP = 0o40
export const INLCR = 0o100
export const IGNCR = 0o200
export const ICRNL = 0o400
export const IXON = 0o2000
export const IUTF8 = 0o40000
// c_oflag
export const OPOST = 0o1
export const ONLCR = 0o4
// c_cflag
export const CS8 = 0o60
export const CREAD = 0o200
export const HUPCL = 0o2000
export const B38400 = 0o17
// c_lflag
export const ISIG = 0o1
export const ICANON = 0o2
export const ECHO = 0o10
export const ECHOE = 0o20
export const ECHOK = 0o40
export const ECHONL = 0o100
export const NOFLSH = 0o200
export const ECHOCTL = 0o1000
export const ECHOKE = 0o4000
export const IEXTEN = 0o100000
// c_cc indices
export const VINTR = 0
export const VQUIT = 1
export const VERASE = 2
export const VKILL = 3
export const VEOF = 4
export const VTIME = 5
export const VMIN = 6
export const VSTART = 8
export const VSTOP = 9
export const VSUSP = 10
export const VEOL = 11
export const VREPRINT = 12
export const VWERASE = 14
export const VLNEXT = 15
export const VEOL2 = 16
export const NCCS = 19

/** What a new terminal starts with: `stty sane` on Linux. */
export function defaultTermios(): Termios {
  const cc = new Array<number>(NCCS).fill(0)
  cc[VINTR] = 0x03
  cc[VQUIT] = 0x1c
  cc[VERASE] = 0x7f
  cc[VKILL] = 0x15
  cc[VEOF] = 0x04
  cc[VMIN] = 1
  cc[VSTART] = 0x11
  cc[VSTOP] = 0x13
  cc[VSUSP] = 0x1a
  cc[VREPRINT] = 0x12
  cc[VWERASE] = 0x17
  cc[VLNEXT] = 0x16
  return {
    iflag: ICRNL | IXON | IUTF8,
    oflag: OPOST | ONLCR,
    cflag: B38400 | CS8 | CREAD | HUPCL,
    lflag: ISIG | ICANON | ECHO | ECHOE | ECHOK | ECHOCTL | ECHOKE | IEXTEN,
    cc,
  }
}
