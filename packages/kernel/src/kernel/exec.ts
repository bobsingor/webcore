// Executable resolution: PATH lookup, then the file header picks the personality.
import { kerr } from '../abi/errno.ts'
import type { Personality } from '../abi/protocol.ts'
import { resolve } from './path.ts'
import type { FileNode, MemFS, VNode } from './vfs.ts'

export interface Executable {
  path: string
  personality: Personality
  /** argv as the program sees it (rewritten for `#!` interpreters). */
  argv: string[]
  node: FileNode
}

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d]
const PERSONALITY_PREFIX = 'personality:'
const MAX_INTERPRETER_DEPTH = 4
const decoder = new TextDecoder()

export function resolveExecutable(fs: MemFS, argv: string[], cwd: string, PATH: string): Executable {
  return load(fs, findCommand(fs, argv[0], cwd, PATH), argv, cwd, PATH, 0)
}

export function findCommand(fs: MemFS, command: string, cwd: string, PATH: string): string {
  if (!command) throw kerr('ENOENT')
  if (command.includes('/')) return resolve(cwd, command)
  for (const dir of PATH.split(':')) {
    if (!dir) continue
    const candidate = resolve(cwd, `${dir}/${command}`)
    if (tryLookup(fs, candidate)?.kind === 'file') return candidate
  }
  throw kerr('ENOENT', command)
}

function load(fs: MemFS, path: string, argv: string[], cwd: string, PATH: string, depth: number): Executable {
  if (depth > MAX_INTERPRETER_DEPTH) throw kerr('ELOOP', path)
  const node = fs.lookup(path)
  if (node.kind !== 'file') throw kerr('EACCES', path)
  const head = node.data.subarray(0, Math.min(node.size, 256))

  if (WASM_MAGIC.every((byte, i) => head[i] === byte)) return { path, personality: 'wasi', argv, node }

  if (head[0] === 0x23 && head[1] === 0x21) {
    const line = decoder.decode(head).split('\n')[0].slice(2).trim()
    if (line.startsWith(PERSONALITY_PREFIX)) {
      const personality = line.slice(PERSONALITY_PREFIX.length)
      if (personality !== 'node') throw kerr('ENOEXEC', path)
      return { path, personality, argv, node }
    }
    const [interpreter, ...interpreterArgs] = line.split(/\s+/)
    const rest = [path, ...argv.slice(1)]
    // `#!/usr/bin/env node` is ubiquitous in npm bin scripts; resolve through PATH until there is
    // a real `env` binary.
    if (interpreter === '/usr/bin/env' && !tryLookup(fs, interpreter) && interpreterArgs.length) {
      const [command, ...commandArgs] = interpreterArgs
      const target = findCommand(fs, command, cwd, PATH)
      return load(fs, target, [command, ...commandArgs, ...rest], cwd, PATH, depth + 1)
    }
    return load(fs, resolve(cwd, interpreter), [interpreter, ...interpreterArgs, ...rest], cwd, PATH, depth + 1)
  }

  throw kerr('ENOEXEC', path)
}

function tryLookup(fs: MemFS, path: string): VNode | undefined {
  try {
    return fs.lookup(path)
  } catch {
    return undefined
  }
}
