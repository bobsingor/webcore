// Pseudo-terminals (M2a). A master/slave pair with a subset of Linux's line discipline (n_tty)
// between them. What the master writes is terminal input: it's echoed, edited into lines in
// canonical mode, and turned into signals for the foreground process group (^C, ^\). What the slave
// writes is terminal output, with `\n` → `\r\n` (ONLCR). The master is the terminal emulator's end
// (xterm.js through the SDK); programs get the slave as stdin, stdout and stderr.
import { kerr } from '../abi/errno.ts'
import { O_RDWR, S_IFCHR } from '../abi/constants.ts'
import type { Stat } from '../abi/constants.ts'
import {
  defaultTermios,
  ECHO,
  ECHOCTL,
  ECHOE,
  ECHOK,
  ECHOKE,
  ECHONL,
  ICANON,
  ICRNL,
  IEXTEN,
  IGNCR,
  INLCR,
  ISIG,
  ISTRIP,
  IUTF8,
  IXON,
  NCCS,
  NOFLSH,
  ONLCR,
  OPOST,
  SIGINT,
  SIGQUIT,
  SIGTSTP,
  SIGWINCH,
  VEOF,
  VEOL,
  VEOL2,
  VERASE,
  VINTR,
  VKILL,
  VLNEXT,
  VMIN,
  VQUIT,
  VREPRINT,
  VSTART,
  VSTOP,
  VSUSP,
  VTIME,
  VWERASE,
  type Termios,
  type WinSize,
} from '../abi/signals.ts'
import { OpenFile, pseudoStat } from './files.ts'

const EMPTY = new Uint8Array(0)
/** Linux's N_TTY_BUF_SIZE: input beyond it is dropped. */
const INPUT_LIMIT = 4096
const OUTPUT_CAPACITY = 64 * 1024
const NEWLINE = 0x0a
const CR = 0x0d

type Waiter = () => void

export interface PtyHooks {
  /** Sends `signal` to process group `pgid` (^C, ^\, ^Z, resizes). */
  signalGroup(pgid: number, signal: number): void
  /** The master closed: the session hangs up. */
  hangup(pty: Pty): void
}

export class Pty {
  readonly index: number
  termios: Termios = defaultTermios()
  winsize: WinSize
  /** The session this is the controlling terminal of. */
  session?: number
  #foreground?: number
  private readonly hooks: PtyHooks
  // Input: master → slave.
  private line: number[] = []
  /** Readable by the slave: complete lines in canonical mode, bytes otherwise. null is ^D (EOF). */
  private input: (Uint8Array | null)[] = []
  private inputBytes = 0
  private literalNext = false
  private readers: Waiter[] = []
  // Output: slave → master.
  private output: Uint8Array[] = []
  private outputBytes = 0
  private outputWaiters: Waiter[] = []
  private masterReaders: Waiter[] = []
  private masterOpen = true
  private slaveOpen = true

  constructor(index: number, winsize: WinSize, hooks: PtyHooks) {
    this.index = index
    this.winsize = { rows: winsize.rows, cols: winsize.cols }
    this.hooks = hooks
  }

  /** The foreground process group: where ^C goes, and who may read. */
  get foreground(): number | undefined {
    return this.#foreground
  }

  set foreground(pgid: number | undefined) {
    this.#foreground = pgid
    // Readers waiting for their turn may proceed.
    this.wake(this.readers)
  }

  get open(): boolean {
    return this.masterOpen || this.slaveOpen
  }

  // --- settings ---------------------------------------------------------------------------------

  setTermios(next: Termios, flush: boolean): void {
    if (![next?.iflag, next?.oflag, next?.cflag, next?.lflag].every(Number.isInteger) || !Array.isArray(next.cc)) {
      throw kerr('EINVAL')
    }
    const wasCanonical = this.canonical
    this.termios = { iflag: next.iflag, oflag: next.oflag, cflag: next.cflag, lflag: next.lflag, cc: [...next.cc.slice(0, NCCS)] }
    while (this.termios.cc.length < NCCS) this.termios.cc.push(0)
    if (flush) this.flushInput()
    // Leaving canonical mode makes the line being edited readable, as on Linux.
    if (wasCanonical && !this.canonical && this.line.length) {
      this.queueInput(Uint8Array.from(this.line))
      this.line = []
    }
    this.wake(this.readers)
  }

  resize(size: WinSize): void {
    const rows = Math.max(0, size?.rows | 0)
    const cols = Math.max(0, size?.cols | 0)
    if (rows === this.winsize.rows && cols === this.winsize.cols) return
    this.winsize = { rows, cols }
    if (this.foreground !== undefined) this.hooks.signalGroup(this.foreground, SIGWINCH)
  }

  /** Bytes the slave can read now (FIONREAD). */
  get available(): number {
    return this.inputBytes
  }

  private get canonical(): boolean {
    return (this.termios.lflag & ICANON) !== 0
  }

  // --- input (master writes) --------------------------------------------------------------------

  /** Terminal input, as typed. Never blocks: like a keyboard, input beyond the limit is lost. */
  receive(data: Uint8Array): number {
    if (!this.slaveOpen) throw kerr('EIO')
    for (const byte of data) this.receiveByte(byte)
    this.wake(this.readers)
    return data.length
  }

  private receiveByte(input: number): void {
    const { iflag, lflag, cc } = this.termios
    let c = iflag & ISTRIP ? input & 0x7f : input
    if (this.literalNext) {
      this.literalNext = false
      return this.addChar(c, true)
    }
    if (c === CR) {
      if (iflag & IGNCR) return
      if (iflag & ICRNL) c = NEWLINE
    } else if (c === NEWLINE && iflag & INLCR) c = CR

    if (lflag & ISIG) {
      const signal = c === cc[VINTR] ? SIGINT : c === cc[VQUIT] ? SIGQUIT : c === cc[VSUSP] ? SIGTSTP : 0
      if (signal && c !== 0) {
        if (!(lflag & NOFLSH)) this.flushInput()
        this.echoChar(c)
        if (this.foreground !== undefined) this.hooks.signalGroup(this.foreground, signal)
        return
      }
    }
    // Flow control isn't emulated: ^S and ^Q are swallowed rather than freezing output.
    if (iflag & IXON && (c === cc[VSTOP] || c === cc[VSTART]) && c !== 0) return

    if (!this.canonical) return this.addChar(c, false)

    if (lflag & IEXTEN && c === cc[VLNEXT] && c !== 0) {
      this.literalNext = true
      if (lflag & ECHO && lflag & ECHOCTL) this.echo([0x5e, 0x08]) // "^", then back over it
      return
    }
    if (c === cc[VERASE] && c !== 0) return this.erase('char')
    if (c === cc[VKILL] && c !== 0) return this.erase('line')
    if (lflag & IEXTEN && c === cc[VWERASE] && c !== 0) return this.erase('word')
    if (lflag & IEXTEN && c === cc[VREPRINT] && c !== 0) {
      this.echoChar(c)
      this.echo([CR, NEWLINE, ...this.line])
      return
    }
    if (c === cc[VEOF] && c !== 0) {
      // ^D ends the line without a newline; on an empty line, the reader sees end of file.
      if (this.line.length) this.queueInput(Uint8Array.from(this.line))
      else this.input.push(null)
      this.line = []
      return
    }
    if (c === NEWLINE || ((c === cc[VEOL] || c === cc[VEOL2]) && c !== 0)) {
      this.line.push(c)
      if (lflag & ECHO || (c === NEWLINE && lflag & ECHONL)) this.echo([c])
      this.queueInput(Uint8Array.from(this.line))
      this.line = []
      return
    }
    this.addChar(c, false)
  }

  private addChar(c: number, literal: boolean): void {
    if (this.canonical) {
      if (this.line.length >= INPUT_LIMIT - 1) return
      this.line.push(c)
    } else {
      if (this.inputBytes >= INPUT_LIMIT * 16) return
      this.queueInput(Uint8Array.of(c))
    }
    if (literal && this.termios.lflag & ECHO) this.echo([c])
    else this.echoChar(c)
  }

  private queueInput(bytes: Uint8Array): void {
    // In raw mode, coalesce single bytes so a read takes what's there.
    const last = this.input[this.input.length - 1]
    if (!this.canonical && last && last.length < 256) {
      const merged = new Uint8Array(last.length + bytes.length)
      merged.set(last)
      merged.set(bytes, last.length)
      this.input[this.input.length - 1] = merged
    } else this.input.push(bytes)
    this.inputBytes += bytes.length
  }

  private erase(kind: 'char' | 'line' | 'word'): void {
    const { lflag } = this.termios
    if (!this.line.length) return
    if (kind === 'line' && !(lflag & ECHOKE)) {
      this.line = []
      if (lflag & ECHO) {
        this.echoChar(this.termios.cc[VKILL])
        if (lflag & ECHOK) this.echo([NEWLINE])
      }
      return
    }
    const erased: number[] = []
    const eraseOne = () => {
      let byte = this.line.pop()!
      erased.push(byte)
      // A UTF-8 character is erased whole.
      if (this.termios.iflag & IUTF8) {
        while ((byte & 0xc0) === 0x80 && this.line.length) {
          byte = this.line.pop()!
          erased.push(byte)
        }
      }
      // Control characters were echoed as two columns (^X).
      const width = byte < 0x20 || byte === 0x7f ? (lflag & ECHOCTL ? 2 : 0) : 1
      if (lflag & ECHO && lflag & ECHOE) for (let i = 0; i < width; i++) this.echo([0x08, 0x20, 0x08])
    }
    if (kind === 'char') eraseOne()
    else if (kind === 'line') while (this.line.length) eraseOne()
    else {
      while (this.line.length && isSpace(this.line[this.line.length - 1])) eraseOne()
      while (this.line.length && !isSpace(this.line[this.line.length - 1])) eraseOne()
    }
  }

  private flushInput(): void {
    this.line = []
    this.input = []
    this.inputBytes = 0
    this.literalNext = false
  }

  private echoChar(c: number): void {
    const { lflag } = this.termios
    if (!(lflag & ECHO)) return
    if (lflag & ECHOCTL && (c < 0x20 || c === 0x7f) && c !== 0x09 && c !== NEWLINE && c !== CR) {
      this.echo([0x5e, c === 0x7f ? 0x3f : c + 0x40])
    } else this.echo([c])
  }

  /** Echo goes to the master even when output is full: typing never blocks. */
  private echo(bytes: number[]): void {
    if (!this.masterOpen) return
    this.pushOutput(this.processOutput(Uint8Array.from(bytes)))
  }

  // --- slave reads ------------------------------------------------------------------------------

  /**
   * Reads terminal input. A reader in the terminal's session but outside its foreground group waits
   * until its group is in the foreground: on Linux, SIGTTIN would stop it. A shell's pending read
   * thereby never takes input meant for the job it started.
   */
  async read(max: number, signal?: AbortSignal, reader?: { pgid: number; sid: number }): Promise<Uint8Array> {
    for (;;) {
      if (!this.masterOpen) return EMPTY
      if (reader && reader.sid === this.session && this.#foreground !== undefined && reader.pgid !== this.#foreground) {
        await this.park(this.readers, signal)
        continue
      }
      const head = this.input[0]
      if (head === null) {
        this.input.shift()
        return EMPTY
      }
      if (head !== undefined) {
        // Non-canonical reads wait for VMIN bytes (VTIME's inter-byte timer isn't emulated).
        const min = this.canonical ? 1 : Math.min(Math.max(this.termios.cc[VMIN], 1), max)
        if (this.canonical || this.inputBytes >= min) return this.take(max)
      } else if (!this.canonical && this.termios.cc[VMIN] === 0) {
        if (this.termios.cc[VTIME] === 0) return EMPTY
        // VMIN 0, VTIME > 0: wait up to VTIME tenths of a second for anything.
        await Promise.race([this.park(this.readers, signal), new Promise((resolve) => setTimeout(resolve, this.termios.cc[VTIME] * 100))])
        const next = this.input[0]
        return next ? this.take(max) : EMPTY
      }
      await this.park(this.readers, signal)
    }
  }

  private take(max: number): Uint8Array {
    if (this.canonical) {
      // A canonical read returns at most one line.
      const line = this.input[0]!
      const out = line.subarray(0, Math.min(max, line.length))
      if (out.length === line.length) this.input.shift()
      else this.input[0] = line.subarray(out.length)
      this.inputBytes -= out.length
      return out.slice()
    }
    const out = new Uint8Array(Math.min(max, this.inputBytes))
    let offset = 0
    while (offset < out.length) {
      const chunk = this.input[0]
      if (!chunk) break
      const n = Math.min(chunk.length, out.length - offset)
      out.set(chunk.subarray(0, n), offset)
      offset += n
      if (n === chunk.length) this.input.shift()
      else this.input[0] = chunk.subarray(n)
    }
    this.inputBytes -= offset
    return offset === out.length ? out : out.subarray(0, offset)
  }

  // --- output (slave writes, master reads) ------------------------------------------------------

  async write(data: Uint8Array, signal?: AbortSignal): Promise<number> {
    for (;;) {
      if (!this.masterOpen) throw kerr('EIO')
      if (this.outputBytes < OUTPUT_CAPACITY) {
        if (data.length) this.pushOutput(this.processOutput(data))
        return data.length
      }
      await this.park(this.outputWaiters, signal)
    }
  }

  private processOutput(data: Uint8Array): Uint8Array {
    const { oflag } = this.termios
    if (!(oflag & OPOST) || !(oflag & ONLCR) || !data.includes(NEWLINE)) return data.slice()
    const out: number[] = []
    for (const byte of data) {
      if (byte === NEWLINE) out.push(CR)
      out.push(byte)
    }
    return Uint8Array.from(out)
  }

  private pushOutput(bytes: Uint8Array): void {
    if (!bytes.length) return
    this.output.push(bytes)
    this.outputBytes += bytes.length
    this.wake(this.masterReaders)
  }

  async readOutput(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    for (;;) {
      if (!this.masterOpen) return EMPTY
      if (this.outputBytes) {
        const out = new Uint8Array(Math.min(max, this.outputBytes))
        let offset = 0
        while (offset < out.length) {
          const chunk = this.output[0]
          const n = Math.min(chunk.length, out.length - offset)
          out.set(chunk.subarray(0, n), offset)
          offset += n
          if (n === chunk.length) this.output.shift()
          else this.output[0] = chunk.subarray(n)
        }
        this.outputBytes -= out.length
        this.wake(this.outputWaiters)
        return out
      }
      if (!this.slaveOpen) return EMPTY
      await this.park(this.masterReaders, signal)
    }
  }

  // --- lifecycle --------------------------------------------------------------------------------

  closeMaster(): void {
    if (!this.masterOpen) return
    this.masterOpen = false
    this.output = []
    this.outputBytes = 0
    this.wake(this.readers)
    this.wake(this.outputWaiters)
    this.wake(this.masterReaders)
    this.hooks.hangup(this)
  }

  closeSlave(): void {
    this.slaveOpen = false
    this.wake(this.masterReaders)
  }

  private park(queue: Waiter[], signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(kerr('EINTR'))
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = queue.indexOf(waiter)
        if (index >= 0) queue.splice(index, 1)
        reject(kerr('EINTR'))
      }
      const waiter = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      queue.push(waiter)
    })
  }

  private wake(queue: Waiter[]): void {
    for (const waiter of queue.splice(0)) waiter()
  }
}

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09
}

/** The terminal emulator's end. Writes are keyboard input; reads are what programs print. */
export class PtyMaster extends OpenFile {
  readonly type = 'chardev'
  readonly pty: Pty

  constructor(pty: Pty) {
    super(O_RDWR)
    this.pty = pty
  }

  override read(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.pty.readOutput(max, signal)
  }

  override write(data: Uint8Array): number {
    return this.pty.receive(data)
  }

  stat(): Stat {
    return pseudoStat('chardev', S_IFCHR | 0o620, 0)
  }

  protected override closed(): void {
    this.pty.closeMaster()
  }
}

/** The programs' end: a terminal (`isatty`), at /dev/pts/<index>. */
export class PtySlave extends OpenFile {
  readonly type = 'chardev'
  readonly pty: Pty

  constructor(pty: Pty) {
    super(O_RDWR)
    this.pty = pty
  }

  override read(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.pty.read(max, signal)
  }

  override write(data: Uint8Array, signal?: AbortSignal): Promise<number> {
    return this.pty.write(data, signal)
  }

  stat(): Stat {
    return pseudoStat('chardev', S_IFCHR | 0o620, 0)
  }

  protected override closed(): void {
    this.pty.closeSlave()
  }
}

/** The terminal behind an fd, if it is one. */
export function ptyOf(file: OpenFile): Pty | undefined {
  return file instanceof PtySlave || file instanceof PtyMaster ? file.pty : undefined
}
