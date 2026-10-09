// A tiny host-side shell for the playground and tests: quoting, $VAR/$?/~ expansion, pipes,
// redirections, && / || / ;, and the cd/pwd/export builtins. It is temporary: from M2 the shell
// is a real process (bash or BusyBox ash via WASIX).
import type { Kernel } from '../kernel/kernel.ts'
import { resolve } from '../kernel/path.ts'
import { pipeline, type Command, type ExecOptions } from './exec.ts'

export interface Shell {
  cwd: string
  env: Record<string, string>
  status: number
}

type Segment = { text: string } | { variable: string }
type Word = Segment[]
type Operator = '|' | '>' | '>>' | '<' | '&&' | '||' | ';'
type Token = { word: Word } | { op: Operator }

interface ParsedCommand {
  argv: Word[]
  stdin?: Word
  stdout?: { path: Word; append: boolean }
}

interface ParsedPipeline {
  commands: ParsedCommand[]
  /** How this pipeline relates to the previous one. */
  after: '&&' | '||' | ';'
}

export class ShellSyntaxError extends Error {}

export function createShell(init: Partial<Shell> = {}): Shell {
  return { cwd: init.cwd ?? '/', env: { ...init.env }, status: init.status ?? 0 }
}

export function tokenize(line: string): Token[] {
  const tokens: Token[] = []
  let word: Word | null = null
  const text = (value: string) => {
    word ??= []
    const last = word[word.length - 1]
    if (last && 'text' in last) last.text += value
    else word.push({ text: value })
  }
  const flush = () => {
    if (word) tokens.push({ word })
    word = null
  }
  const readVariable = (i: number): number => {
    if (line[i + 1] === '?') {
      ;(word ??= []).push({ variable: '?' })
      return i + 1
    }
    if (line[i + 1] === '{') {
      const end = line.indexOf('}', i + 2)
      if (end < 0) throw new ShellSyntaxError('bad substitution')
      ;(word ??= []).push({ variable: line.slice(i + 2, end) })
      return end
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i + 1))?.[0]
    if (!name) {
      text('$')
      return i
    }
    ;(word ??= []).push({ variable: name })
    return i + name.length
  }

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === ' ' || char === '\t' || char === '\n') {
      flush()
    } else if (char === '#' && word === null) {
      break
    } else if (char === "'") {
      const end = line.indexOf("'", i + 1)
      if (end < 0) throw new ShellSyntaxError('unterminated quote')
      text(line.slice(i + 1, end))
      i = end
    } else if (char === '"') {
      text('')
      for (i++; ; i++) {
        if (i >= line.length) throw new ShellSyntaxError('unterminated quote')
        if (line[i] === '"') break
        if (line[i] === '\\' && '"\\$`'.includes(line[i + 1] ?? '')) text(line[++i])
        else if (line[i] === '$') i = readVariable(i)
        else text(line[i])
      }
    } else if (char === '\\') {
      if (i + 1 < line.length) text(line[++i])
    } else if (char === '$') {
      i = readVariable(i)
    } else if (char === '~' && word === null && (line[i + 1] === undefined || /[\s/]/.test(line[i + 1]))) {
      word = [{ variable: 'HOME' }]
    } else if ('|&;<>'.includes(char)) {
      flush()
      const pair = line.slice(i, i + 2)
      if (pair === '||' || pair === '&&' || pair === '>>') {
        tokens.push({ op: pair })
        i++
      } else if (char === '&') {
        throw new ShellSyntaxError('background jobs (&) are not supported')
      } else {
        tokens.push({ op: char as Operator })
      }
    } else {
      text(char)
    }
  }
  flush()
  return tokens
}

export function parse(tokens: Token[]): ParsedPipeline[] {
  const pipelines: ParsedPipeline[] = []
  let commands: ParsedCommand[] = []
  let command: ParsedCommand = { argv: [] }
  let after: ParsedPipeline['after'] = ';'

  const endCommand = (op: string) => {
    if (!command.argv.length) throw new ShellSyntaxError(`syntax error near unexpected token \`${op}'`)
    commands.push(command)
    command = { argv: [] }
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if ('word' in token) {
      command.argv.push(token.word)
      continue
    }
    const { op } = token
    if (op === '<' || op === '>' || op === '>>') {
      const target = tokens[++i]
      if (!target || !('word' in target)) throw new ShellSyntaxError(`syntax error near \`${op}'`)
      if (op === '<') command.stdin = target.word
      else command.stdout = { path: target.word, append: op === '>>' }
    } else if (op === '|') {
      endCommand(op)
    } else {
      endCommand(op)
      pipelines.push({ commands, after })
      commands = []
      after = op
    }
  }
  if (command.argv.length) commands.push(command)
  else if (commands.length) throw new ShellSyntaxError('syntax error: unexpected end of line')
  if (commands.length) pipelines.push({ commands, after })
  return pipelines
}

function expand(word: Word, shell: Shell): string {
  return word
    .map((segment) =>
      'text' in segment ? segment.text : segment.variable === '?' ? String(shell.status) : (shell.env[segment.variable] ?? ''),
    )
    .join('')
}

/** Runs one line of shell input. Returns the exit status. */
export async function runLine(
  kernel: Kernel,
  shell: Shell,
  line: string,
  io: Pick<ExecOptions, 'onStdout' | 'onStderr' | 'signal'> = {},
): Promise<number> {
  const encoder = new TextEncoder()
  const print = (text: string) => io.onStdout?.(encoder.encode(text))
  const fail = (text: string, status: number) => {
    io.onStderr?.(encoder.encode(text))
    return status
  }

  let pipelines: ParsedPipeline[]
  try {
    pipelines = parse(tokenize(line))
  } catch (error) {
    if (!(error instanceof ShellSyntaxError)) throw error
    return (shell.status = fail(`sh: ${error.message}\n`, 2))
  }

  for (const { commands, after } of pipelines) {
    if (io.signal?.aborted) break
    if ((after === '&&' && shell.status !== 0) || (after === '||' && shell.status === 0)) continue

    const expanded: Command[] = commands.map((command) => ({
      argv: command.argv.map((word) => expand(word, shell)),
      stdin: command.stdin && expand(command.stdin, shell),
      stdout: command.stdout && { path: expand(command.stdout.path, shell), append: command.stdout.append },
    }))
    const [first] = expanded
    const builtin = expanded.length === 1 && !first.stdin && !first.stdout ? first.argv : undefined

    if (builtin?.[0] === 'cd') {
      const target = resolve(shell.cwd, builtin[1] ?? shell.env.HOME ?? '/')
      let isDir = false
      try {
        isDir = kernel.fs.lookup(target).kind === 'dir'
      } catch {
        // Reported below.
      }
      if (isDir) {
        shell.cwd = target
        shell.env.PWD = target
        shell.status = 0
      } else {
        shell.status = fail(`sh: cd: ${builtin[1]}: No such file or directory\n`, 1)
      }
    } else if (builtin?.[0] === 'pwd') {
      print(`${shell.cwd}\n`)
      shell.status = 0
    } else if (builtin?.[0] === 'export') {
      for (const assignment of builtin.slice(1)) {
        const eq = assignment.indexOf('=')
        if (eq > 0) shell.env[assignment.slice(0, eq)] = assignment.slice(eq + 1)
      }
      shell.status = 0
    } else if (builtin?.[0] === 'true' || builtin?.[0] === 'false') {
      shell.status = builtin[0] === 'true' ? 0 : 1
    } else {
      const result = await pipeline(kernel, expanded, { ...io, cwd: shell.cwd, env: shell.env })
      shell.status = result.code
    }
  }
  return shell.status
}
