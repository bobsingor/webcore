// Pseudo-terminals, signals, Node on a TTY and Node's REPL (M2a); the interactive shell, BusyBox's
// hush, with line editing and job control (M2c). Expected behaviour is Linux's (n_tty) and real
// Node's.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ENV, ECHO, exec, ICANON, TCGETS, type Kernel, type PtyMaster } from '../src/index.ts'
import { boot, sh } from './helpers.ts'

let kernel: Kernel

beforeEach(() => {
  kernel = boot()
})

afterEach(() => {
  kernel.shutdown()
})

/** Runs argv on a new terminal, as a terminal emulator would. */
function terminal(argv: string[], size = { cols: 100, rows: 30 }) {
  const { master, slave } = kernel.openpty(size)
  const proc = kernel.spawn(argv, {
    cwd: '/home/user',
    env: { ...DEFAULT_ENV, PWD: '/home/user', TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    stdio: [slave, slave, slave],
    terminal: slave,
  })
  slave.release()
  let screen = ''
  const decoder = new TextDecoder()
  void (async () => {
    for (let chunk = await master.read(65536); chunk.length; chunk = await master.read(65536)) screen += decoder.decode(chunk, { stream: true })
  })()
  /** The screen as text: escape sequences removed, backspaces and carriage returns applied. */
  const text = () => render(screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))
  return {
    master: master as PtyMaster,
    proc,
    text,
    raw: () => screen,
    type: (keys: string) => master.write(new TextEncoder().encode(keys)),
    async waitFor(pattern: RegExp | string, timeout = 8000): Promise<void> {
      const deadline = Date.now() + timeout
      const matches = () => (typeof pattern === 'string' ? text().includes(pattern) : pattern.test(text()))
      while (!matches()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern} in:\n${text()}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
  }
}

/** A minimal screen: \b and \r move the cursor, characters overwrite. */
function render(output: string): string {
  const lines: string[][] = [[]]
  let column = 0
  for (const char of output) {
    const line = lines[lines.length - 1]
    if (char === '\n') {
      lines.push([])
      column = 0
    } else if (char === '\r') column = 0
    else if (char === '\b') column = Math.max(0, column - 1)
    else line[column++] = char
  }
  return lines.map((line) => Array.from(line, (char) => char ?? ' ').join('')).join('\n')
}

describe('pseudo-terminals', () => {
  it('edits lines in canonical mode, echoes, and maps newlines', async () => {
    const term = terminal(['cat'])
    term.type('hello wor\x7f\x7fld\r')
    await term.waitFor('hello wld\nhello wld\n')
    // ^U kills the line, ^W a word; control characters echo as ^X.
    term.type('one two\x17three\x15four\x01\r')
    // Erasing leaves blanks behind on the screen, as on a real terminal.
    await term.waitFor(/four\^A *\nfour\x01\n/)
    term.type('\x04')
    expect(await term.proc.exited).toBe(0)
    expect(term.raw()).toContain('hello wld\r\n')
  })

  it('sends ^C to the foreground group, which a handler can catch', async () => {
    const plain = terminal(['node', '-e', 'setInterval(() => {}, 1000)'])
    await new Promise((resolve) => setTimeout(resolve, 300))
    plain.type('\x03')
    expect(await plain.proc.exited).toBe(130)
    await plain.waitFor('^C')

    const handled = terminal(['node', '-e', "process.on('SIGINT', () => { console.log('caught'); process.exit(3) }); console.log('ready'); setInterval(() => {}, 1000)"])
    await handled.waitFor('ready\n')
    handled.type('\x03')
    expect(await handled.proc.exited).toBe(3)
    await handled.waitFor('ready\n^Ccaught\n')
  })

  it('gives Node a TTY: size, colors, raw mode, SIGWINCH, and its mode back at exit', async () => {
    const term = terminal([
      'node',
      '-e',
      `console.log([process.stdin.isTTY, process.stdout.isTTY, process.stdout.columns, process.stdout.rows, process.stdout.getColorDepth()].join(' '))
      process.stdout.on('resize', () => console.log('resized', process.stdout.columns, process.stdout.rows))
      process.stdin.setRawMode(true)
      process.stdin.on('data', (data) => {
        console.log('key', JSON.stringify(data.toString()))
        if (data[0] === 3) process.exit(0)
      })`,
    ])
    await term.waitFor('true true 100 30 24\n')
    term.master.pty.resize({ cols: 120, rows: 40 })
    await term.waitFor('resized 120 40')
    term.type('ab')
    await term.waitFor('key "ab"')
    term.type('\x1b[A')
    await term.waitFor('key "\\u001b[A"')
    term.type('\x03')
    expect(await term.proc.exited).toBe(0)
    // Raw mode ended with the process (libuv's uv_tty_reset_mode).
    const { lflag } = term.master.pty.termios
    expect(lflag & ICANON && lflag & ECHO).toBeTruthy()
  })

  it('reports terminals through ioctl only', async () => {
    const { stdout } = await sh(kernel, `node -e "try { process.webcore.syscall('ioctl', 1, ${TCGETS}) } catch (e) { console.log(e.code) }"`)
    expect(stdout).toBe('ENOTTY\n')
  })
})

describe('signals', () => {
  it('delivers handled signals and takes default actions otherwise', async () => {
    // Without a shell, which would report the job's end ("Terminated").
    const { stdout, code } = await exec(kernel, [
      'node',
      '-e',
      `process.on('SIGUSR1', (name) => console.log('handled', name))
      process.kill(process.pid, 'SIGUSR1')
      const onTerm = () => { console.log('handled SIGTERM'); process.off('SIGTERM', onTerm); process.kill(process.pid, 'SIGTERM') }
      setTimeout(() => { process.on('SIGTERM', onTerm); process.kill(process.pid, 'SIGTERM') }, 20)
      setInterval(() => {}, 1000)`,
    ])
    expect(stdout).toBe('handled SIGUSR1\nhandled SIGTERM\n')
    expect(code).toBe(143)
  })

  it('keeps SIGKILL uncatchable and lets programs ignore other signals', async () => {
    const { stdout } = await sh(
      kernel,
      `node -e "
        try { process.on('SIGKILL', () => {}) } catch (error) { console.log(error.code) }
        console.log(process.webcore.syscall('sigaction', 2, 'ignore'))
        process.kill(process.pid, 'SIGINT')
        setTimeout(() => console.log('survived SIGINT'), 20)
      "`,
    )
    expect(stdout).toBe('EINVAL\ndefault\nsurvived SIGINT\n')
  })
})

describe('interactive sh', () => {
  it('runs jobs in the foreground, and ^C returns to the prompt', async () => {
    const term = terminal(['sh', '-l'])
    await term.waitFor(/Welcome to webcore[\s\S]*user@webcore:~\$ $/)
    term.type('cd /tmp && pwd\r')
    await term.waitFor(/\/tmp\nuser@webcore:\/tmp\$ $/)
    term.type('node -e "setInterval(() => {}, 1000)"\r')
    await new Promise((resolve) => setTimeout(resolve, 400))
    term.type('\x03')
    await term.waitFor(/\^C\nuser@webcore:\/tmp\$ $/)
    term.type('echo status $?\r')
    await term.waitFor('status 130')
    // Input reaches the job, not the shell that waits for it.
    term.type('cat\r')
    await new Promise((resolve) => setTimeout(resolve, 300))
    term.type('typed into cat\r')
    await term.waitFor('typed into cat\ntyped into cat\n')
    term.type('\x04')
    await term.waitFor(/typed into cat\nuser@webcore:\/tmp\$ $/)
    // A pipeline is one job, even when its first stage ends before the last one starts.
    term.type('/bin/echo one two | wc | cat\r')
    await term.waitFor('        1         2         8\n')
    // An incomplete line asks for more (PS2).
    term.type('if true\r')
    await term.waitFor(/> $/)
    term.type('then echo continued; fi\r')
    await term.waitFor('continued')
    term.type('exit 4\r')
    expect(await term.proc.exited).toBe(4)
  })

  it('exits on ^D at an empty prompt', async () => {
    const term = terminal(['sh'])
    await term.waitFor('$ ')
    term.type('\x04')
    expect(await term.proc.exited).toBe(0)
  })

  it('stops a job with ^Z, and continues it with bg and fg', async () => {
    const term = terminal(['sh'])
    await term.waitFor('$ ')
    term.type('node -e "let n = 0; setInterval(() => console.log(\'tick\', ++n), 100)"\r')
    await term.waitFor('tick 2')
    term.type('\x1a')
    await term.waitFor(/\^Z.*\n.*\$ $/)
    term.type('jobs\r')
    await term.waitFor(/\[1\]\+? +Stopped +node -e.*\n.*\$ $/)
    // Stopped: its output stops too.
    const stopped = term.text().length
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(term.text().length).toBe(stopped)
    term.type('bg\r')
    await term.waitFor(/tick \d+\n[\s\S]*tick \d+\n/)
    term.type('jobs\r')
    await term.waitFor(/\[1\]\+? +Running +node -e/)
    term.type('fg\r')
    await new Promise((resolve) => setTimeout(resolve, 200))
    term.type('\x03')
    await term.waitFor(/\^C\n.*\$ $/)
    term.type('echo status $?; jobs\r')
    await term.waitFor(/status 130\n.*\$ $/)
    term.type('exit\r')
    expect(await term.proc.exited).toBe(0)
  })

  it('hangs up the stopped jobs of a shell that exits', async () => {
    const term = terminal(['sh'])
    await term.waitFor('$ ')
    term.type('sleep 100\r')
    await new Promise((resolve) => setTimeout(resolve, 300))
    term.type('\x1a')
    await term.waitFor(/\^Z.*sleep 100\n.*\$ $/)
    term.type('exit\r')
    expect(await term.proc.exited).toBe(0)
    // The stopped job's group is orphaned: SIGHUP, then SIGCONT, end it.
    while (kernel.processes.some((proc) => proc.alive)) await new Promise((resolve) => setTimeout(resolve, 10))
  })

  it('edits lines, recalls history and completes paths', async () => {
    const term = terminal(['sh'])
    await term.waitFor('$ ')
    term.type('echo first\r')
    await term.waitFor('first\n')
    // Up recalls the last line; Left moves the cursor into it.
    term.type('\x1b[A\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D-\r')
    await term.waitFor('-first\n')
    term.type('ls /et\t')
    await term.waitFor('ls /etc/')
    term.type('\r')
    await term.waitFor('motd')
    term.type('exit\r')
    expect(await term.proc.exited).toBe(0)
  })

  it('runs vi and less full-screen', async () => {
    const term = terminal(['sh'])
    await term.waitFor('$ ')
    term.type('vi notes.txt\r')
    // vi's status line.
    await term.waitFor('- notes.txt 1/1')
    term.type('ihello from vi')
    await new Promise((resolve) => setTimeout(resolve, 200))
    // Escape alone (no sequence follows) leaves insert mode.
    term.type('\x1b')
    await new Promise((resolve) => setTimeout(resolve, 300))
    term.type(':wq\r')
    await term.waitFor("'notes.txt' 1L, 14C")
    expect(new TextDecoder().decode(kernel.fs.readFile('/home/user/notes.txt'))).toBe('hello from vi\n')
    term.type('seq 1 100 | less\r')
    await term.waitFor(/^29$/m)
    term.type(' ')
    await term.waitFor(/^58$/m)
    term.type('q')
    term.type('echo done\r')
    await term.waitFor('done\n')
    term.type('exit\r')
    expect(await term.proc.exited).toBe(0)
  })
})

describe('node', () => {
  it('starts the REPL on a terminal', async () => {
    const term = terminal(['node'])
    await term.waitFor('Welcome to Node.js v24.21.0.')
    term.type('[1, 2, 3].map((n) => n ** 2)\r')
    await term.waitFor('[ 1, 4, 9 ]')
    term.type('process.ver\t')
    await term.waitFor('process.version')
    term.type('\r')
    await term.waitFor("'v24.21.0'")
    term.type('.exit\r')
    expect(await term.proc.exited).toBe(0)
  })

  it('runs code in vm contexts without the process’s globals', async () => {
    const { stdout } = await sh(
      kernel,
      `node -e "
        const vm = require('vm')
        console.log(vm.runInNewContext('typeof process + \\' \\' + typeof require + \\' \\' + typeof JSON'))
        const ctx = vm.createContext({ x: 2 })
        console.log(vm.runInContext('var y = x * 21; function twice(n) { return n * 2 } twice(y)', ctx), ctx.y, typeof ctx.twice)
        console.log(vm.runInContext('twice(5) + this.x', ctx), vm.isContext(ctx))
      "`,
    )
    expect(stdout).toBe('undefined undefined object\n84 42 function\n12 true\n')
  })
})
