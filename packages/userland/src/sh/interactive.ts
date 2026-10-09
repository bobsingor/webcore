// Interactive sh (M2a). Lines come from the terminal through Node's readline, which brings history
// and line editing. Each pipeline runs as a job: a process group of its own, in the terminal's
// foreground (shell.ts). The shell ignores the terminal's signals itself, so ^C reaches the job,
// and at the prompt ^C abandons the line.
import { existsSync, readdirSync } from 'node:fs'
import { hostname } from 'node:os'
import { createInterface } from 'node:readline'
import { SIGINT, SIGQUIT, SIGTSTP, SIGTTIN, SIGTTOU, sys } from '../lib/kernel.ts'
import { BUILTINS } from './builtins.ts'
import { parse, ShellSyntaxError, type List } from './parse.ts'
import { ExitSignal, type Shell } from './shell.ts'

const DEFAULT_PS1 = '\\u@\\h:\\w\\$ '
const STDIO = { stdin: 0, stdout: 1, stderr: 2 }

export async function interactive(shell: Shell, options: { login: boolean }): Promise<number> {
  takeTerminal(shell)
  if (options.login) {
    for (const file of ['/etc/profile', `${shell.vars.get('HOME') ?? ''}/.profile`]) {
      if (!existsSync(file)) continue
      const status = await runList(shell, parse(`. '${file.replace(/'/g, `'\\''`)}'`))
      if (status instanceof ExitSignal) return status.status
    }
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 500,
    removeHistoryDuplicates: true,
    completer: (line: string) => complete(shell, line),
  })
  const lines: (string | null)[] = []
  let wake: (() => void) | undefined
  rl.on('line', (line) => {
    lines.push(line)
    wake?.()
  })
  rl.on('close', () => {
    lines.push(null)
    wake?.()
  })
  let pending = ''
  // ^C at the prompt: readline has the terminal in raw mode, so it arrives as a key.
  rl.on('SIGINT', () => {
    pending = ''
    process.stdout.write('^C\n')
    const state = rl as unknown as { line: string; cursor: number }
    state.line = ''
    state.cursor = 0
    rl.setPrompt(prompt(shell, shell.vars.get('PS1') ?? DEFAULT_PS1))
    rl.prompt()
  })

  const stdin = process.stdin as typeof process.stdin & { setRawMode?: (raw: boolean) => void }
  for (;;) {
    rl.setPrompt(pending ? prompt(shell, shell.vars.get('PS2') ?? '> ') : prompt(shell, shell.vars.get('PS1') ?? DEFAULT_PS1))
    // Like bash's readline, raw mode only while a line is read (a job may have changed the mode).
    stdin.setRawMode?.(true)
    rl.prompt()
    while (!lines.length) await new Promise<void>((resolve) => (wake = resolve))
    const line = lines.shift()!
    if (line === null) {
      process.stdout.write('exit\n')
      return shell.status
    }
    const source = pending ? `${pending}\n${line}` : line
    let list: List
    try {
      list = parse(source)
    } catch (error) {
      if (error instanceof ShellSyntaxError && error.incomplete) {
        pending = source
        continue
      }
      pending = ''
      process.stderr.write(`sh: ${error instanceof Error ? error.message : String(error)}\n`)
      shell.status = 2
      continue
    }
    pending = ''
    // The job gets the terminal in its normal mode (^C is SIGINT again), and reads it directly.
    rl.pause()
    stdin.setRawMode?.(false)
    const result = await runList(shell, list)
    if (result instanceof ExitSignal) {
      rl.close()
      return result.status
    }
  }
}

async function runList(shell: Shell, list: List): Promise<number | ExitSignal> {
  try {
    return await shell.runList(list, STDIO)
  } catch (error) {
    if (error instanceof ExitSignal) return error
    process.stderr.write(`sh: ${error instanceof Error ? error.message : String(error)}\n`)
    return (shell.status = 2)
  }
}

/** Job control: the shell leads its own group, holds the terminal, and ignores its signals. */
function takeTerminal(shell: Shell): void {
  for (const signal of [SIGINT, SIGQUIT, SIGTSTP, SIGTTIN, SIGTTOU]) sys.sigaction(signal, 'ignore')
  try {
    try {
      sys.setpgid(0, 0)
    } catch {
      // A session leader already leads its group.
    }
    sys.tcsetpgrp(0, process.pid)
    shell.jobControl = { tty: 0, pgid: process.pid }
  } catch {
    // Not this session's terminal: run commands without job control.
  }
}

/** PS1 and PS2: bash's backslash escapes, the common ones. */
function prompt(shell: Shell, template: string): string {
  const home = shell.vars.get('HOME') ?? ''
  const cwd = shell.cwd
  const short = home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd
  const host = hostname()
  return template.replace(/\\(\[|\]|e|a|n|u|h|H|w|W|\$|\\|0[0-7]{2})/g, (_, code: string) => {
    switch (code) {
      case '[':
      case ']':
        return ''
      case 'e':
        return '\x1b'
      case 'a':
        return '\x07'
      case 'n':
        return '\n'
      case 'u':
        return shell.vars.get('USER') ?? 'user'
      case 'h':
        return host.split('.')[0]
      case 'H':
        return host
      case 'w':
        return short
      case 'W':
        return short === '~' || cwd === '/' ? short : cwd.slice(cwd.lastIndexOf('/') + 1)
      case '$':
        return process.getuid?.() === 0 ? '#' : '$'
      case '\\':
        return '\\'
      default:
        return String.fromCharCode(Number.parseInt(code, 8))
    }
  })
}

/** Tab completion: commands for the first word, paths for the rest. */
function complete(shell: Shell, line: string): [string[], string] {
  const word = /\S*$/.exec(line)![0]
  const first = !line.slice(0, line.length - word.length).trim()
  if (first && !word.includes('/')) {
    const names = new Set(Object.keys(BUILTINS))
    for (const dir of (shell.vars.get('PATH') ?? '').split(':')) {
      try {
        for (const name of readdirSync(dir)) names.add(name)
      } catch {
        // A missing PATH entry.
      }
    }
    const hits = [...names].filter((name) => name.startsWith(word)).sort()
    return [hits.length === 1 ? [`${hits[0]} `] : hits, word]
  }
  const slash = word.lastIndexOf('/')
  const prefix = word.slice(0, slash + 1)
  const base = word.slice(slash + 1)
  const home = shell.vars.get('HOME') ?? ''
  const dir = shell.resolvePath(prefix.replace(/^~(?=\/|$)/, home) || '.')
  try {
    const hits = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.name.startsWith(base) && (base.startsWith('.') || !entry.name.startsWith('.')))
      .map((entry) => `${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`)
      .sort()
    return [hits.length === 1 && !hits[0].endsWith('/') ? [`${hits[0]} `] : hits, word]
  } catch {
    return [[], word]
  }
}
