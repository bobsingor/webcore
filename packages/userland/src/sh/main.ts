#!/usr/bin/env node
// sh: webcore's shell. `sh -c 'command' [name [args…]]`, `sh script [args…]`, or a script on
// stdin. The language is a POSIX subset (see parse.ts); commands run on the kernel directly.
import { readFileSync } from 'node:fs'
import { parse, ShellSyntaxError } from './parse.ts'
import { ExitSignal, Shell } from './shell.ts'

async function main(argv: string[]): Promise<number> {
  let command: string | undefined
  let errexit = false
  let xtrace = false
  let i = 0
  for (; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      i++
      break
    }
    if (!/^[-+][a-z]+$/.test(arg)) break
    if (arg.includes('e')) errexit = true
    if (arg.includes('x')) xtrace = true
    if (arg.includes('c')) {
      command = argv[++i]
      if (command === undefined) {
        process.stderr.write('sh: -c: option requires an argument\n')
        return 2
      }
    }
  }
  const rest = argv.slice(i)

  let source: string
  let arg0 = 'sh'
  let positional = rest
  if (command !== undefined) {
    source = command
    arg0 = rest[0] ?? 'sh'
    positional = rest.slice(1)
  } else if (rest.length) {
    arg0 = rest[0]
    positional = rest.slice(1)
    try {
      source = readFileSync(rest[0], 'utf8')
    } catch {
      process.stderr.write(`sh: 0: cannot open ${rest[0]}: No such file\n`)
      return 127
    }
  } else {
    source = readFileSync(0, 'utf8')
  }

  const shell = new Shell({ env: { ...process.env } as Record<string, string>, cwd: process.cwd(), arg0, positional })
  shell.errexit = errexit
  shell.xtrace = xtrace
  try {
    return await shell.runList(parse(source), { stdin: 0, stdout: 1, stderr: 2 })
  } catch (error) {
    if (error instanceof ExitSignal) return error.status
    if (error instanceof ShellSyntaxError) {
      process.stderr.write(`sh: ${error.message}\n`)
      return 2
    }
    throw error
  }
}

process.exit(await main(process.argv.slice(2)))
