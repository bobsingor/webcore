// Shell builtins. Besides the POSIX ones, a few file utilities (rm, mkdir, cp, mv, touch) stand in
// for coreutils, which npm scripts call constantly, until real ones arrive (BusyBox, M2).
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname } from 'node:path'
import { ExitSignal, type IO, type Shell } from './shell.ts'

export type Builtin = (shell: Shell, argv: string[], io: IO) => number | Promise<number>

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function fail(shell: Shell, io: IO, message: string, status = 1): number {
  shell.print(io.stderr, `${message}\n`)
  return status
}

/** Splits leading single-letter flags (-rf) from operands. */
function flags(argv: string[]): [Set<string>, string[]] {
  const set = new Set<string>()
  let i = 1
  for (; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      i++
      break
    }
    if (!/^-[A-Za-z]+$/.test(arg)) break
    for (const flag of arg.slice(1)) set.add(flag)
  }
  return [set, argv.slice(i)]
}

function isExecutable(shell: Shell, name: string): string | undefined {
  if (name.includes('/')) return existsSync(shell.resolvePath(name)) ? name : undefined
  for (const dir of (shell.vars.get('PATH') ?? '').split(':')) {
    if (!dir) continue
    const candidate = `${dir}/${name}`
    try {
      if (statSync(shell.resolvePath(candidate)).isFile()) return candidate
    } catch {
      // Not in this directory.
    }
  }
  return undefined
}

function test(shell: Shell, args: string[]): boolean {
  if (args[0] === '!') return !test(shell, args.slice(1))
  if (args.length === 0) return false
  if (args.length === 1) return args[0] !== ''
  if (args.length === 2) {
    const [op, operand] = args
    const path = () => shell.resolvePath(operand)
    const stat = (follow = true) => {
      try {
        return follow ? statSync(path()) : lstatSync(path())
      } catch {
        return undefined
      }
    }
    switch (op) {
      case '-n':
        return operand !== ''
      case '-z':
        return operand === ''
      case '-e':
      case '-r':
      case '-w':
        return stat() !== undefined
      case '-f':
        return stat()?.isFile() ?? false
      case '-d':
        return stat()?.isDirectory() ?? false
      case '-x':
        return ((stat()?.mode ?? 0) & 0o111) !== 0
      case '-s':
        return (stat()?.size ?? 0) > 0
      case '-L':
      case '-h':
        return stat(false)?.isSymbolicLink() ?? false
    }
    return false
  }
  if (args.length >= 4 && (args.includes('-a') || args.includes('-o'))) {
    const index = args.lastIndexOf('-o') >= 0 ? args.lastIndexOf('-o') : args.lastIndexOf('-a')
    const left = test(shell, args.slice(0, index))
    const right = test(shell, args.slice(index + 1))
    return args[index] === '-o' ? left || right : left && right
  }
  const [a, op, b] = args
  switch (op) {
    case '=':
    case '==':
      return a === b
    case '!=':
      return a !== b
    case '-eq':
      return Number(a) === Number(b)
    case '-ne':
      return Number(a) !== Number(b)
    case '-lt':
      return Number(a) < Number(b)
    case '-le':
      return Number(a) <= Number(b)
    case '-gt':
      return Number(a) > Number(b)
    case '-ge':
      return Number(a) >= Number(b)
  }
  return false
}

function copy(from: string, to: string, recursive: boolean): void {
  const stat = statSync(from)
  if (stat.isDirectory()) {
    if (!recursive) throw new Error(`-r not specified; omitting directory '${from}'`)
    mkdirSync(to, { recursive: true })
    for (const name of readdirSync(from)) copy(`${from}/${name}`, `${to}/${name}`, true)
  } else {
    writeFileSync(to, readFileSync(from))
  }
}

export const BUILTINS: Record<string, Builtin> = {
  ':': () => 0,
  true: () => 0,
  false: () => 1,

  cd: (shell, argv, io) => {
    const home = shell.vars.get('HOME') ?? '/'
    let target = argv[1] ?? home
    if (target === '-') target = shell.vars.get('OLDPWD') ?? shell.cwd
    const path = shell.resolvePath(target)
    try {
      if (!statSync(path).isDirectory()) return fail(shell, io, `sh: cd: ${target}: Not a directory`)
    } catch {
      return fail(shell, io, `sh: cd: ${target}: No such file or directory`)
    }
    const normalized = new URL(`file://${path}`).pathname.replace(/\/$/, '') || '/'
    shell.vars.set('OLDPWD', shell.cwd)
    shell.setVar('PWD', normalized)
    return 0
  },

  // Clears the screen and its scrollback, as ncurses' clear does on xterm.
  clear: (shell, _argv, io) => {
    shell.print(io.stdout, '\x1b[H\x1b[2J\x1b[3J')
    return 0
  },
  pwd: (shell, _argv, io) => {
    shell.print(io.stdout, `${shell.cwd}\n`)
    return 0
  },

  echo: (shell, argv, io) => {
    let args = argv.slice(1)
    let newline = true
    let escapes = false
    while (args[0] && /^-[neE]+$/.test(args[0])) {
      if (args[0].includes('n')) newline = false
      if (args[0].includes('e')) escapes = true
      args = args.slice(1)
    }
    let text = args.join(' ')
    if (escapes) text = text.replace(/\\([nt\\])/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : '\\'))
    shell.print(io.stdout, newline ? `${text}\n` : text)
    return 0
  },

  printf: (shell, argv, io) => {
    const [format = '', ...args] = argv.slice(1)
    let i = 0
    const text = format
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/%([sdx%])/g, (_, kind: string) => {
        if (kind === '%') return '%'
        const arg = args[i++] ?? ''
        return kind === 'd' ? String(Number.parseInt(arg, 10) || 0) : kind === 'x' ? (Number.parseInt(arg, 10) || 0).toString(16) : arg
      })
    shell.print(io.stdout, text)
    return 0
  },

  export: (shell, argv) => {
    for (const arg of argv.slice(1)) {
      if (arg === '-p') continue
      const eq = arg.indexOf('=')
      const name = eq < 0 ? arg : arg.slice(0, eq)
      if (eq >= 0) shell.setVar(name, arg.slice(eq + 1))
      shell.exported.add(name)
    }
    return 0
  },

  unset: (shell, argv) => {
    for (const name of argv.slice(1)) {
      if (name === '-v' || name === '-f') continue
      shell.vars.delete(name)
      shell.exported.delete(name)
    }
    return 0
  },

  set: (shell, argv) => {
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i]
      if (arg === '--') {
        shell.positional = argv.slice(i + 1)
        break
      }
      if (arg === '-o' || arg === '+o') {
        i++
        continue
      }
      if (/^[-+][a-z]+$/.test(arg)) {
        const on = arg[0] === '-'
        if (arg.includes('e')) shell.errexit = on
        if (arg.includes('x')) shell.xtrace = on
        continue
      }
      shell.positional = argv.slice(i)
      break
    }
    return 0
  },

  shift: (shell, argv) => {
    shell.positional = shell.positional.slice(Number(argv[1] ?? 1))
    return 0
  },

  exit: (shell, argv) => {
    throw new ExitSignal(argv[1] === undefined ? shell.status : Number(argv[1]) & 0xff)
  },

  test: (shell, argv) => (test(shell, argv.slice(1)) ? 0 : 1),

  '[': (shell, argv, io) => {
    if (argv[argv.length - 1] !== ']') return fail(shell, io, 'sh: [: missing ]', 2)
    return test(shell, argv.slice(1, -1)) ? 0 : 1
  },

  command: async (shell, argv, io) => {
    if (argv[1] === '-v' || argv[1] === '-V') {
      let status = 1
      for (const name of argv.slice(2)) {
        const found = Object.hasOwn(BUILTINS, name) ? name : isExecutable(shell, name)
        if (found) {
          shell.print(io.stdout, `${found}\n`)
          status = 0
        }
      }
      return status
    }
    return argv.length > 1 ? shell.spawnAndWait(argv.slice(1), io) : 0
  },

  which: (shell, argv, io) => {
    let status = 0
    for (const name of argv.slice(1)) {
      const found = isExecutable(shell, name)
      if (found) shell.print(io.stdout, `${found}\n`)
      else status = 1
    }
    return status
  },

  type: (shell, argv, io) => {
    let status = 0
    for (const name of argv.slice(1)) {
      if (Object.hasOwn(BUILTINS, name)) shell.print(io.stdout, `${name} is a shell builtin\n`)
      else {
        const found = isExecutable(shell, name)
        if (found) shell.print(io.stdout, `${name} is ${found}\n`)
        else status = fail(shell, io, `sh: type: ${name}: not found`)
      }
    }
    return status
  },

  exec: async (shell, argv, io) => {
    if (argv.length < 2) return 0
    throw new ExitSignal(await shell.spawnAndWait(argv.slice(1), io))
  },

  wait: async (shell) => {
    await shell.waitJobs()
    return 0
  },

  '.': async (shell, argv, io) => {
    if (!argv[1]) return fail(shell, io, 'sh: .: filename argument required', 2)
    try {
      return await shell.source(readFileSync(shell.resolvePath(argv[1]), 'utf8'), io)
    } catch (error) {
      if (error instanceof ExitSignal) throw error
      return fail(shell, io, `sh: .: ${argv[1]}: not found`)
    }
  },

  env: async (shell, argv, io) => {
    const extra = new Map<string, string>()
    let i = 1
    for (; i < argv.length && NAME.test(argv[i].split('=')[0]) && argv[i].includes('='); i++) {
      const eq = argv[i].indexOf('=')
      extra.set(argv[i].slice(0, eq), argv[i].slice(eq + 1))
    }
    if (i < argv.length) return shell.spawnAndWait(argv.slice(i), io, extra)
    const env = shell.env(extra)
    shell.print(io.stdout, Object.entries(env).map(([name, value]) => `${name}=${value}\n`).join(''))
    return 0
  },

  sleep: async (_shell, argv) => {
    await new Promise((resolve) => setTimeout(resolve, Number.parseFloat(argv[1] ?? '0') * 1000))
    return 0
  },

  basename: (shell, argv, io) => {
    let name = basename(argv[1] ?? '')
    if (argv[2] && name.endsWith(argv[2])) name = name.slice(0, -argv[2].length)
    shell.print(io.stdout, `${name}\n`)
    return 0
  },

  dirname: (shell, argv, io) => {
    shell.print(io.stdout, `${dirname(argv[1] ?? '.')}\n`)
    return 0
  },

  // --- coreutils stand-ins -------------------------------------------------------------------

  rm: (shell, argv, io) => {
    const [opts, paths] = flags(argv)
    let status = 0
    for (const path of paths) {
      try {
        rmSync(shell.resolvePath(path), { recursive: opts.has('r') || opts.has('R'), force: opts.has('f') })
      } catch (error) {
        status = fail(shell, io, `rm: cannot remove '${path}': ${(error as Error).message.replace(/^[A-Z]+: /, '')}`)
      }
    }
    return status
  },

  mkdir: (shell, argv, io) => {
    const [opts, paths] = flags(argv)
    let status = 0
    for (const path of paths) {
      try {
        mkdirSync(shell.resolvePath(path), { recursive: opts.has('p') })
      } catch (error) {
        status = fail(shell, io, `mkdir: cannot create directory '${path}': ${(error as NodeJS.ErrnoException).code === 'EEXIST' ? 'File exists' : (error as Error).message}`)
      }
    }
    return status
  },

  touch: (shell, argv, io) => {
    const [, paths] = flags(argv)
    for (const path of paths) {
      const target = shell.resolvePath(path)
      try {
        if (existsSync(target)) utimesSync(target, new Date(), new Date())
        else closeSync(openSync(target, 'a'))
      } catch (error) {
        return fail(shell, io, `touch: cannot touch '${path}': ${(error as Error).message}`)
      }
    }
    return 0
  },

  cp: (shell, argv, io) => {
    const [opts, paths] = flags(argv)
    if (paths.length < 2) return fail(shell, io, 'cp: missing destination file operand')
    const destination = shell.resolvePath(paths[paths.length - 1])
    const intoDirectory = existsSync(destination) && statSync(destination).isDirectory()
    for (const source of paths.slice(0, -1)) {
      try {
        copy(shell.resolvePath(source), intoDirectory ? `${destination}/${basename(source)}` : destination, opts.has('r') || opts.has('R'))
      } catch (error) {
        return fail(shell, io, `cp: ${(error as Error).message}`)
      }
    }
    return 0
  },

  mv: (shell, argv, io) => {
    const [, paths] = flags(argv)
    if (paths.length < 2) return fail(shell, io, 'mv: missing destination file operand')
    const destination = shell.resolvePath(paths[paths.length - 1])
    const intoDirectory = existsSync(destination) && statSync(destination).isDirectory()
    for (const source of paths.slice(0, -1)) {
      try {
        renameSync(shell.resolvePath(source), intoDirectory ? `${destination}/${basename(source)}` : destination)
      } catch (error) {
        return fail(shell, io, `mv: ${(error as Error).message}`)
      }
    }
    return 0
  },
}
