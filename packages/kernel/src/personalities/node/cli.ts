// Node's command-line parsing (src/node_options.cc), driven by the option table extracted from
// Node's own source (packages/node-lib/scripts/options.mjs).
import type { NodeLib, OptionValue } from './lib.ts'
import { host } from './host.ts'

export interface CommandLine {
  /** process.execArgv */
  execArgv: string[]
  /** process.argv: [execPath, script?, ...args] */
  argv: string[]
  /** getCLIOptionsValues() */
  options: Record<string, OptionValue>
  /** Handled before bootstrap, like Node's C++ does. */
  version: boolean
  /** Set when the command line is invalid: the message to print, as `node: <message>`. */
  error?: string
}

export class BadOption extends Error {}

function splitNodeOptions(value: string): string[] {
  const out: string[] = []
  for (const match of value.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) out.push(match[1] ?? match[2])
  return out
}

export function parseCommandLine(lib: NodeLib, argv: string[], execPath: string, env: Record<string, string>): CommandLine {
  const defaults = lib.options
  const options: Record<string, OptionValue> = host.structuredClone(defaults)
  const execArgv: string[] = []
  let version = false

  const set = (name: string, value: string | undefined, takeNext: () => string | undefined) => {
    if (name === '--version') {
      version = true
      return
    }
    if (!(name in defaults)) {
      // V8 options (absent from the table) are accepted and ignored.
      if (/^--(max-old-space-size|max-semi-space-size|stack-size|expose-gc|harmony|jitless|no-)/.test(name)) return
      throw new BadOption(`bad option: ${name}`)
    }
    const current = defaults[name]
    if (typeof current === 'boolean') {
      options[name] = value === undefined ? true : value !== 'false'
    } else {
      const raw = value ?? takeNext()
      if (raw === undefined) throw new BadOption(`${name} requires an argument`)
      if (Array.isArray(current)) (options[name] as string[]).push(raw)
      else if (typeof current === 'number') options[name] = Number(raw)
      else if (typeof current === 'object' && current) {
        const [host, port] = raw.includes(':') ? raw.split(':') : ['127.0.0.1', raw]
        options[name] = { host, port: Number(port) }
      } else options[name] = raw
    }
    if (name === '--eval') options['[has_eval_string]'] = true
  }

  const apply = (tokens: string[], recordExecArgv: boolean): number => {
    let i = 0
    for (; i < tokens.length; i++) {
      const token = tokens[i]
      if (token === '--') {
        i++
        break
      }
      if (!token.startsWith('-') || token === '-') break
      const start = i
      const eq = token.startsWith('--') ? token.indexOf('=') : -1
      let name = eq > 0 ? token.slice(0, eq) : token
      const inline = eq > 0 ? token.slice(eq + 1) : undefined
      const takeNext = () => tokens[++i]

      // `--print <arg>` and `-p <arg>` mean print-and-eval.
      if ((name === '-p' || name === '--print') && inline === undefined && tokens[i + 1] !== undefined && !tokens[i + 1].startsWith('-')) {
        options['--print'] = true
        set('--eval', takeNext(), takeNext)
      } else if (name.startsWith('--no-') && typeof defaults[`--${name.slice(5)}`] === 'boolean') {
        options[`--${name.slice(5)}`] = false
      } else {
        const expansion = lib.aliases[name] ?? [name]
        if (expansion.length > 1) {
          // e.g. -pe → --print --eval <arg>
          for (const part of expansion.slice(0, -1)) set(part, undefined, () => undefined)
          name = expansion[expansion.length - 1]
        } else {
          name = expansion[0]
        }
        if (name === '-v') name = '--version'
        set(name, inline, takeNext)
      }
      if (recordExecArgv) execArgv.push(...tokens.slice(start, i + 1))
    }
    return i
  }

  try {
    if (env.NODE_OPTIONS) apply(splitNodeOptions(env.NODE_OPTIONS), false)
    const rest = argv.slice(1)
    const consumed = apply(rest, true)
    return { execArgv, argv: [execPath, ...rest.slice(consumed)], options, version }
  } catch (error) {
    if (!(error instanceof BadOption)) throw error
    return { execArgv, argv: [execPath], options, version, error: error.message }
  }
}

/** Mirrors SelectLoadMode in src/node.cc. */
export function selectMainScript(commandLine: CommandLine): string {
  const { options, argv } = commandLine
  if (options['[has_eval_string]'] && !options['--interactive']) return 'internal/main/eval_string'
  if (options['--check']) return 'internal/main/check_syntax'
  if (options['--test']) return 'internal/main/test_runner'
  if (options['--watch']) return 'internal/main/watch_mode'
  if (argv.length > 1 && argv[1] !== '-') return 'internal/main/run_main_module'
  return 'internal/main/eval_stdin'
}
