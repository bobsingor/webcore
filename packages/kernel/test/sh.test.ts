// /bin/sh (packages/userland/src/sh): the language, pipelines on kernel pipes, Node's
// child_process shell, and process groups.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exec, DEFAULT_ENV, type Kernel } from '../src/index.ts'
import { boot, sh } from './helpers.ts'

let kernel: Kernel

beforeEach(() => {
  kernel = boot()
})

afterEach(() => {
  kernel.shutdown()
})

/** Runs a script with the guest /bin/sh (not the host's test shell). */
async function script(lines: string[], args: string[] = [], signal?: AbortSignal) {
  kernel.fs.writeFile('/home/user/script.sh', lines.join('\n'))
  return exec(kernel, ['/bin/sh', 'script.sh', ...args], { cwd: '/home/user', env: { ...DEFAULT_ENV, PWD: '/home/user' }, signal })
}

describe('sh', () => {
  it('runs lists, pipelines, redirections and substitutions', async () => {
    const result = await script(
      [
        'echo one two | wc',
        'echo first > out.txt && echo second >> out.txt; cat < out.txt',
        'false || echo "or $?"',
        'missing-command 2>/dev/null; echo "status $?"',
        'NAME=world; echo "hello ${NAME}" \'$NAME\' "$(echo nested $(echo deeper))"',
        'echo ${UNSET:-fallback} ${#NAME} $1 $# "$@"',
        "GREETING=hi sh -c 'echo child sees $GREETING'",
        '(echo from-stderr >&2) 2>&1',
      ],
      ['a', 'b c'],
    )
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(
      [
        '      1       2       8',
        'first',
        'second',
        'or 1',
        'status 127',
        'hello world $NAME nested deeper',
        'fallback 5 a 2 a b c',
        'child sees hi',
        'from-stderr',
        '',
      ].join('\n'),
    )
  })

  it('has if, for, while, globbing, test and file builtins', async () => {
    kernel.fs.mkdirp('/home/user/src')
    for (const name of ['a.js', 'b.js', 'c.css']) kernel.fs.writeFile(`/home/user/src/${name}`, '')
    const result = await script([
      'for f in src/*.js; do echo "js: $f"; done',
      'if [ -f src/c.css ] && [ ! -d src/c.css ]; then echo css; elif true; then echo no; else echo never; fi',
      'n=x; while [ "$n" != xxx ]; do n="${n}x"; echo "$n"; done',
      'echo src/*.none',
      'mkdir -p deep/dir && touch deep/dir/f && cp -r deep copy && rm -rf deep && ls copy/dir',
      'cd copy && pwd',
      'exit 4',
      'echo unreachable',
    ])
    expect(result.stdout).toBe('js: src/a.js\njs: src/b.js\ncss\nxx\nxxx\nsrc/*.none\nf\n/home/user/copy\n')
    expect(result.code).toBe(4)
  })

  it('serves Node’s child_process shell', async () => {
    const result = await sh(
      kernel,
      `node -e "const cp = require('child_process'); console.log(cp.execSync('echo a && echo b | cat', { encoding: 'utf8' }).trim()); cp.exec('exit 3', (e) => console.log('code', e.code))"`,
    )
    expect(result.stdout).toBe('a\nb\ncode 3\n')
  })

  it('stops a whole job, children included, on Ctrl+C', async () => {
    const abort = new AbortController()
    const running = script(['node -e "setInterval(() => {}, 1000)" &', 'node -e "setInterval(() => {}, 1000)"'], [], abort.signal)
    while (kernel.processes.filter((proc) => proc.alive).length < 3) await new Promise((resolve) => setTimeout(resolve, 20))
    abort.abort()
    const result = await running
    expect(result.code).toBe(130)
    expect(kernel.processes.filter((proc) => proc.alive)).toEqual([])
  })
})
