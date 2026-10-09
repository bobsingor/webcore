// The shell's executor. Commands run on the kernel ABI directly, as in a real shell: pipes are
// kernel pipes, children get explicit fds, and the shell waits on their pids.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { O_APPEND, O_CREAT, O_RDONLY, O_RDWR, O_TRUNC, O_WRONLY, isSysError, sys } from '../lib/kernel.ts'
import { BUILTINS, type Builtin } from './builtins.ts'
import { parse, type AndOr, type Command, type List, type Pipeline, type Redirect, type Word } from './parse.ts'

export interface IO {
  stdin: number
  stdout: number
  stderr: number
}

/** Thrown by `exit` to unwind to the top. */
export class ExitSignal {
  readonly status: number
  constructor(status: number) {
    this.status = status
  }
}

const decoder = new TextDecoder()
const IFS = /[ \t\n]+/
const SIGNALS: Record<number, string> = { 2: 'Interrupt', 9: 'Killed', 15: 'Terminated' }

interface Field {
  segments: { text: string; quoted: boolean }[]
  /** Contains a quoted part, so it survives even when empty (""). */
  quoted: boolean
}

export class Shell {
  vars: Map<string, string>
  exported: Set<string>
  cwd: string
  status = 0
  arg0: string
  positional: string[]
  errexit = false
  xtrace = false
  lastBackground = 0
  /** Called with each child's pid (used for $!). */
  onSpawn?: (pid: number) => void
  private readonly jobs = new Set<Promise<number>>()

  constructor(init: { env: Record<string, string>; cwd: string; arg0?: string; positional?: string[] }) {
    this.vars = new Map(Object.entries(init.env))
    this.exported = new Set(Object.keys(init.env))
    this.cwd = init.cwd
    this.arg0 = init.arg0 ?? 'sh'
    this.positional = init.positional ?? []
  }

  /** A subshell: a copy of the state, so changes don't leak back. */
  clone(): Shell {
    const copy = new Shell({ env: {}, cwd: this.cwd, arg0: this.arg0, positional: [...this.positional] })
    copy.vars = new Map(this.vars)
    copy.exported = new Set(this.exported)
    copy.status = this.status
    copy.errexit = this.errexit
    copy.xtrace = this.xtrace
    return copy
  }

  env(extra?: Map<string, string>): Record<string, string> {
    const env: Record<string, string> = {}
    for (const name of this.exported) {
      const value = this.vars.get(name)
      if (value !== undefined) env[name] = value
    }
    if (extra) for (const [name, value] of extra) env[name] = value
    return env
  }

  setVar(name: string, value: string): void {
    this.vars.set(name, value)
    if (name === 'PWD') this.cwd = value
  }

  resolvePath(path: string): string {
    return path.startsWith('/') ? path : `${this.cwd === '/' ? '' : this.cwd}/${path}`
  }

  print(fd: number, text: string): void {
    if (fd >= 0 && text) sys.write(fd, text)
  }

  async source(text: string, io: IO): Promise<number> {
    return this.runList(parse(text), io)
  }

  async waitJobs(): Promise<void> {
    await Promise.all(this.jobs)
  }

  // --- lists and pipelines -------------------------------------------------------------------

  async runList(list: List, io: IO): Promise<number> {
    for (const item of list) {
      if (item.background) {
        // Background jobs read /dev/null (a negative fd), as in a non-interactive shell.
        const sub = this.clone()
        sub.onSpawn = (pid) => (this.lastBackground = pid)
        const job = sub.runAndOr(item.andOr, { ...io, stdin: -1 })
        this.jobs.add(job)
        void job.finally(() => this.jobs.delete(job))
        this.status = 0
        continue
      }
      this.status = await this.runAndOr(item.andOr, io)
    }
    return this.status
  }

  private async runAndOr(andOr: AndOr, io: IO): Promise<number> {
    const conditional = andOr.rest.length > 0
    let status = await this.runPipeline(andOr.first, io, conditional)
    for (const [i, { op, pipeline }] of andOr.rest.entries()) {
      if ((op === '&&') !== (status === 0)) continue
      status = await this.runPipeline(pipeline, io, i < andOr.rest.length - 1)
    }
    this.status = status
    return status
  }

  private async runPipeline(pipeline: Pipeline, io: IO, conditional: boolean): Promise<number> {
    let status: number
    if (pipeline.commands.length === 1) {
      status = await this.runCommand(pipeline.commands[0], io)
    } else {
      const stages: Promise<number>[] = []
      let input = io.stdin
      for (const [i, command] of pipeline.commands.entries()) {
        const last = i === pipeline.commands.length - 1
        const [readEnd, writeEnd] = last ? [-1, io.stdout] : sys.pipe()
        const owned = [input !== io.stdin ? input : -1, last ? -1 : writeEnd].filter((fd) => fd >= 0)
        // Our copies of the pipe ends close once the stage has its own (or is done), so the next
        // stage sees EOF and the previous one EPIPE.
        stages.push(this.runCommand(command, { stdin: input, stdout: writeEnd, stderr: io.stderr }, () => owned.forEach(sys.close)))
        input = readEnd
      }
      status = (await Promise.all(stages)).at(-1)!
    }
    if (pipeline.negate) status = status === 0 ? 1 : 0
    if (this.errexit && status !== 0 && !conditional && !pipeline.negate) throw new ExitSignal(status)
    return status
  }

  // --- commands ------------------------------------------------------------------------------

  /** Runs a command. `release` closes fds the caller handed over, once nothing in here needs them. */
  async runCommand(command: Command, io: IO, release?: () => void): Promise<number> {
    let released = false
    const done = () => {
      if (released) return
      released = true
      release?.()
    }
    const opened: number[] = []
    try {
      const redirected = await this.redirect(command.redirects, io, opened)
      if (!redirected) return (this.status = 1)
      switch (command.type) {
        case 'simple':
          return await this.runSimple(command, redirected, () => {
            opened.forEach(sys.close)
            opened.length = 0
            done()
          })
        case 'group':
          return await this.runList(command.body, redirected)
        case 'subshell':
          return await this.clone().runList(command.body, redirected)
        case 'if': {
          for (const clause of command.clauses) {
            if ((await this.runList(clause.condition, redirected)) === 0) return await this.runList(clause.body, redirected)
          }
          return command.otherwise ? await this.runList(command.otherwise, redirected) : 0
        }
        case 'for': {
          const items = command.items ? await this.expandWords(command.items, io) : this.positional
          let status = 0
          for (const item of items) {
            this.setVar(command.name, item)
            status = await this.runList(command.body, redirected)
          }
          return status
        }
        case 'while': {
          let status = 0
          while (((await this.runList(command.condition, redirected)) === 0) !== command.until) {
            status = await this.runList(command.body, redirected)
          }
          return status
        }
      }
    } finally {
      opened.forEach(sys.close)
      done()
    }
  }

  private async runSimple(command: Extract<Command, { type: 'simple' }>, io: IO, spawned: () => void): Promise<number> {
    const argv = await this.expandWords(command.words, io)
    const assignments = new Map<string, string>()
    for (const { name, value } of command.assignments) assignments.set(name, await this.expandWord(value, io))
    if (!argv.length) {
      for (const [name, value] of assignments) this.setVar(name, value)
      return this.status
    }
    if (this.xtrace) this.print(io.stderr, `+ ${argv.join(' ')}\n`)

    const builtin: Builtin | undefined = Object.hasOwn(BUILTINS, argv[0]) ? BUILTINS[argv[0]] : undefined
    if (builtin) {
      const saved = new Map([...assignments.keys()].map((name) => [name, this.vars.get(name)]))
      for (const [name, value] of assignments) this.vars.set(name, value)
      try {
        return (this.status = await builtin(this, argv, io))
      } finally {
        // Assignments before a builtin are temporary, except for `export`-like uses of the result.
        for (const [name, value] of saved) {
          if (value === undefined) this.vars.delete(name)
          else this.vars.set(name, value)
        }
      }
    }
    return (this.status = await this.spawnAndWait(argv, io, assignments, spawned))
  }

  /** Runs an external command. */
  async spawnAndWait(argv: string[], io: IO, env?: Map<string, string>, spawned?: () => void): Promise<number> {
    let pid: number
    try {
      pid = sys.spawn(argv, { cwd: this.cwd, env: this.env(env), fds: [io.stdin, io.stdout, io.stderr] })
    } catch (error) {
      // Report before releasing: stderr may be one of the fds being released.
      try {
        if (isSysError(error, 'ENOENT')) {
          this.print(io.stderr, `sh: ${argv[0]}: not found\n`)
          return 127
        }
        if (isSysError(error)) {
          this.print(io.stderr, `sh: ${argv[0]}: ${error.code === 'ENOEXEC' ? 'Exec format error' : 'Permission denied'}\n`)
          return 126
        }
        throw error
      } finally {
        spawned?.()
      }
    }
    spawned?.()
    this.onSpawn?.(pid)
    const [code, signal] = await sys.waitStatus(pid)
    if (signal !== null) {
      if (signal !== 2 && SIGNALS[signal]) this.print(io.stderr, `${SIGNALS[signal]}\n`)
      return 128 + signal
    }
    return code ?? 0
  }

  /** Applies redirections, opening files into `opened`. Returns undefined after reporting a failure. */
  private async redirect(redirects: Redirect[], io: IO, opened: number[]): Promise<IO | undefined> {
    if (!redirects.length) return io
    const fds = [io.stdin, io.stdout, io.stderr]
    for (const redirect of redirects) {
      const target = await this.expandWord(redirect.target, io)
      if (redirect.op === '>&' || redirect.op === '<&') {
        if (target === '-') fds[redirect.fd] = -1
        else if (/^\d+$/.test(target)) fds[redirect.fd] = fds[Number(target)] ?? Number(target)
        else {
          this.print(io.stderr, `sh: ${target}: bad file descriptor\n`)
          return undefined
        }
        continue
      }
      const flags =
        redirect.op === '<' ? O_RDONLY
        : redirect.op === '<>' ? O_RDWR | O_CREAT
        : redirect.op === '>>' || redirect.op === '&>>' ? O_WRONLY | O_CREAT | O_APPEND
        : O_WRONLY | O_CREAT | O_TRUNC
      let fd: number
      try {
        fd = sys.open(this.resolvePath(target), flags)
      } catch (error) {
        const reason = isSysError(error, 'ENOENT') ? 'No such file or directory' : isSysError(error, 'EISDIR') ? 'Is a directory' : 'cannot open'
        this.print(io.stderr, `sh: ${target}: ${reason}\n`)
        return undefined
      }
      opened.push(fd)
      if (redirect.op === '&>' || redirect.op === '&>>') fds[1] = fds[2] = fd
      else fds[redirect.fd] = fd
    }
    return { stdin: fds[0], stdout: fds[1], stderr: fds[2] }
  }

  // --- expansion -----------------------------------------------------------------------------

  /** Expands words into fields: parameters, command substitution, splitting, then globbing. */
  async expandWords(words: Word[], io: IO): Promise<string[]> {
    const out: string[] = []
    for (const word of words) {
      for (const field of await this.fields(word, io)) {
        if (!field.segments.length && !field.quoted) continue
        out.push(...this.glob(field))
      }
    }
    return out
  }

  /** Expands one word without splitting or globbing (assignments, redirection targets). */
  async expandWord(word: Word, io: IO): Promise<string> {
    let text = ''
    for (const part of word) {
      if (part.type === 'text') text += part.text
      else if (part.type === 'tilde') text += this.vars.get('HOME') ?? ''
      else if (part.type === 'param') text += (await this.param(part, io)).join(' ')
      else text += await this.capture(part.list, io)
    }
    return text
  }

  private async fields(word: Word, io: IO): Promise<Field[]> {
    const fields: Field[] = [{ segments: [], quoted: false }]
    const current = () => fields[fields.length - 1]
    const append = (text: string, quoted: boolean) => {
      current().segments.push({ text, quoted })
      if (quoted) current().quoted = true
    }
    /** Unquoted expansion results are split on IFS whitespace. */
    const split = (value: string) => {
      if (!value) return
      const pieces = value.split(IFS)
      pieces.forEach((piece, i) => {
        if (i > 0) fields.push({ segments: [], quoted: false })
        if (piece) append(piece, false)
      })
    }
    for (const part of word) {
      if (part.type === 'text') append(part.text, part.quoted)
      else if (part.type === 'tilde') append(this.vars.get('HOME') ?? '', true)
      else if (part.type === 'param') {
        const values = await this.param(part, io)
        if (part.quoted && part.name === '@' && !part.op) {
          // "$@": one field per positional parameter.
          values.forEach((value, i) => {
            if (i > 0) fields.push({ segments: [], quoted: true })
            append(value, true)
          })
        } else if (part.quoted) append(values.join(' '), true)
        else split(values.join(' '))
      } else {
        const output = await this.capture(part.list, io)
        if (part.quoted) append(output, true)
        else split(output)
      }
    }
    return fields
  }

  private async param(part: Extract<Word[number], { type: 'param' }>, io: IO): Promise<string[]> {
    const { name, op } = part
    let value: string | undefined
    let values: string[] | undefined
    if (name === '@' || name === '*') values = this.positional
    else if (name === '?') value = String(this.status)
    else if (name === '$') value = String(process.pid)
    else if (name === '#') value = String(this.positional.length)
    else if (name === '!') value = this.lastBackground ? String(this.lastBackground) : ''
    else if (name === '-') value = this.errexit ? 'e' : ''
    else if (name === '0') value = this.arg0
    else if (/^\d$/.test(name)) value = this.positional[Number(name) - 1]
    else value = this.vars.get(name)

    if (op === '#') return [String((values ? values.join(' ') : (value ?? '')).length)]
    const set = values ? values.length > 0 : value !== undefined
    const empty = values ? values.join('') === '' : !value
    if (op) {
      const useWord = op.startsWith(':') ? !set || empty : !set
      const kind = op.slice(-1)
      if (kind === '-' && useWord) return [await this.expandWord(part.word ?? [], io)]
      if (kind === '=' && useWord) {
        const assigned = await this.expandWord(part.word ?? [], io)
        this.setVar(name, assigned)
        return [assigned]
      }
      if (kind === '+') return useWord ? [] : [await this.expandWord(part.word ?? [], io)]
      if (kind === '?' && useWord) {
        const message = (await this.expandWord(part.word ?? [], io)) || 'parameter not set'
        this.print(io.stderr, `sh: ${name}: ${message}\n`)
        throw new ExitSignal(1)
      }
    }
    if (values) return values
    return value === undefined ? [] : [value]
  }

  /** Command substitution: runs `list` in a subshell and returns its output, minus trailing newlines. */
  private async capture(list: List, io: IO): Promise<string> {
    const [readEnd, writeEnd] = sys.pipe()
    const chunks: Uint8Array[] = []
    const reading = (async () => {
      for (let chunk = await sys.read(readEnd); chunk.length; chunk = await sys.read(readEnd)) chunks.push(chunk)
    })()
    const sub = this.clone()
    try {
      this.status = await sub.runList(list, { ...io, stdout: writeEnd })
    } catch (error) {
      if (!(error instanceof ExitSignal)) throw error
      this.status = error.status
    } finally {
      sys.close(writeEnd)
    }
    await reading
    sys.close(readEnd)
    return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('').replace(/\n+$/, '')
  }

  // --- pathname expansion --------------------------------------------------------------------

  private glob(field: Field): string[] {
    const text = field.segments.map((segment) => segment.text).join('')
    const hasPattern = field.segments.some((segment) => !segment.quoted && /[*?[]/.test(segment.text))
    if (!hasPattern) return [text]
    // A pattern string where quoted characters are escaped.
    const pattern = field.segments.map((segment) => (segment.quoted ? segment.text.replace(/[*?[\\]/g, '\\$&') : segment.text)).join('')
    const absolute = pattern.startsWith('/')
    let matches = [absolute ? '/' : '']
    for (const component of pattern.split('/').filter(Boolean)) {
      const next: string[] = []
      const regex = /[*?[]/.test(component.replace(/\\./g, '')) ? componentRegex(component) : undefined
      for (const base of matches) {
        const dir = this.resolvePath(base || '.')
        if (!regex) {
          const literal = component.replace(/\\(.)/g, '$1')
          next.push(join(base, literal))
          continue
        }
        let names: string[]
        try {
          names = readdirSync(dir)
        } catch {
          continue
        }
        for (const name of names.sort()) {
          if (name.startsWith('.') && !component.startsWith('.')) continue
          if (regex.test(name)) next.push(join(base, name))
        }
      }
      matches = next
    }
    const existing = matches.filter((path) => {
      try {
        statSync(this.resolvePath(path))
        return true
      } catch {
        return false
      }
    })
    return existing.length ? existing : [text]
  }
}

function join(base: string, name: string): string {
  return base === '' ? name : base === '/' ? `/${name}` : `${base}/${name}`
}

/** One path component of a glob pattern as a regular expression. */
function componentRegex(component: string): RegExp {
  let source = ''
  for (let i = 0; i < component.length; i++) {
    const char = component[i]
    if (char === '\\') source += escapeRegex(component[++i] ?? '')
    else if (char === '*') source += '.*'
    else if (char === '?') source += '.'
    else if (char === '[') {
      const end = component.indexOf(']', i + 2)
      if (end < 0) {
        source += '\\['
        continue
      }
      let body = component.slice(i + 1, end)
      const negate = body.startsWith('!') || body.startsWith('^')
      if (negate) body = body.slice(1)
      source += `[${negate ? '^' : ''}${body.replace(/\\/g, '\\\\')}]`
      i = end
    } else source += escapeRegex(char)
  }
  return new RegExp(`^${source}$`, 's')
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/** Reads a script file's text. */
export function readScript(path: string): string {
  return readFileSync(path, 'utf8')
}
