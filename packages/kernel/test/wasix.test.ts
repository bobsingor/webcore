// M2c: the WASIX personality (ADR-0020) and BusyBox on it. C programs start children with vfork
// and exec, wait for them, handle and send signals, and use terminals; libwebcore gives them the
// kernel's process groups, termios, file modes and signal dispositions.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ENV, exec, type Kernel } from '../src/index.ts'
import { boot, sh } from './helpers.ts'

let kernel: Kernel

beforeEach(() => {
  kernel = boot()
})

afterEach(() => {
  kernel.shutdown()
})

const run = (argv: string[], stdin?: string) => exec(kernel, argv, { cwd: '/home/user', env: { ...DEFAULT_ENV, PWD: '/home/user' }, stdin })

describe('WASIX programs', () => {
  it('start children with vfork, exec and posix_spawn, and wait for them', async () => {
    const { code, stdout } = await run(['/usr/bin/vfork'])
    expect(code).toBe(0)
    // The parent's stdout is a pipe, so its own lines are buffered until it exits.
    expect(stdout.split('\n')).toEqual(
      expect.arrayContaining([
        'exec child reaped: exited 3',
        'it wrote: hello from C: pid 2, ppid 1, cwd /home/user',
        'arg 2: vfork',
        '_exit child: exited 5',
        'posix_spawn child: exited 0',
        'missing program: exited 127',
      ]),
    )
  })

  it('handle, ignore and send signals', async () => {
    expect(await run(['/usr/bin/signals'])).toMatchObject({
      code: 0,
      stdout: 'handler ran: yes\nsurvived an ignored SIGINT\nchild: killed by signal 15\n',
    })
  })

  it('see a terminal: its size, termios and raw mode', async () => {
    const { master, slave } = kernel.openpty({ rows: 24, cols: 90 })
    const proc = kernel.spawn(['/usr/bin/termios'], { stdio: [slave, slave, slave], terminal: slave })
    slave.release()
    let screen = ''
    void (async () => {
      for (let chunk = await master.read(4096); chunk.length; chunk = await master.read(4096)) screen += new TextDecoder().decode(chunk)
    })()
    while (!screen.includes('press a key')) await new Promise((resolve) => setTimeout(resolve, 10))
    // Raw mode: one key, no Enter, and no echo.
    master.write(new TextEncoder().encode('k'))
    expect(await proc.exited).toBe(0)
    expect(screen).toBe("isatty: 1 1\r\nsize: 90 x 24\r\ncanonical: 1, echo: 1\r\npress a key: got 'k'\r\n")
    master.release()
  })

  it('runs a program in place with execve, closing close-on-exec fds', async () => {
    kernel.writeFile(
      '/home/user/exec.js',
      `const sys = process.webcore.syscall
      const closing = sys('open', '/etc/motd', 0o2000000)
      const kept = sys('open', '/etc/hostname', 0)
      sys('execve', '/bin/sh', ['sh', '-c', 'echo $$; read name <&' + kept + '; echo "$name"; cat <&' + closing + ' || echo closed'], { ...process.env })`,
    )
    const events: string[] = []
    kernel.events.subscribe((event) => {
      if (event.type === 'process.spawn' || event.type === 'process.exec') events.push(`${event.type} ${event.pid} ${event.argv[0]}`)
    })
    const { code, stdout, stderr } = await run(['node', 'exec.js'])
    expect(code).toBe(0)
    // The same process: node's pid, now sh's.
    const pid = Number(stdout.split('\n')[0])
    expect(events.slice(0, 2)).toEqual([`process.spawn ${pid} node`, `process.exec ${pid} sh`])
    expect(stdout).toBe(`${pid}\nwebcore\nclosed\n`)
    expect(stderr).toMatch(/Bad file descriptor/)
  })
})

describe('BusyBox', () => {
  it('passes exported variables to children and its own applets', async () => {
    const { stdout } = await sh(kernel, 'A=1; export A; env | grep ^A=; sh -c \'echo "child: $A"\'; export B=2; printenv B | cat')
    expect(stdout).toBe('A=1\nchild: 1\n2\n')
  })

  it('reports and changes modes, owners and times', async () => {
    const { stdout } = await sh(
      kernel,
      'umask; umask 027; touch f; mkdir d; stat -c "%A %U:%G %n" f d; chmod 755 f; ls -l f; touch -d "2001-02-03 04:05" f; date -r f +%Y; id; uname -sn',
    )
    const lines = stdout.split('\n')
    expect(lines.slice(0, 3)).toEqual(['0022', '-rw-r----- user:user f', 'drwxr-x--- user:user d'])
    expect(lines[3]).toMatch(/^-rwxr-xr-x +1 user +user +0 .* f$/)
    expect(lines.slice(4)).toEqual(['2001', 'uid=1000(user) gid=1000(user)', 'Linux webcore', ''])
    expect(kernel.fs.stat(kernel.fs.lookup('/home/user/f')).mode & 0o777).toBe(0o755)
  })

  it('runs traps after the foreground job, and restarts the calls a handler interrupted', async () => {
    // The shell waits for each sleep; SIGTERM interrupts that wait, and the trap runs once the
    // sleep is over. Without SA_RESTART the wait would fail ("Interrupted system call").
    const { code, stdout, stderr } = await sh(kernel, 'trap "echo trapped; exit 7" TERM; (sleep 0.2; kill -TERM $$) & while :; do sleep 0.1; done')
    expect({ code, stdout, stderr }).toEqual({ code: 7, stdout: 'trapped\n', stderr: '' })
  })

  it('waits for background jobs, and stops, continues and kills them', async () => {
    const { stdout } = await sh(
      kernel,
      'sleep 0.2 & wait $!; echo "waited $?"; sleep 5 & p=$!; kill -STOP $p; sleep 0.1; jobs; kill -CONT $p; kill $p; wait $p; echo "killed $?"',
    )
    expect(stdout).toBe('waited 0\n[1] Stopped                sleep 5\nkilled 143\n')
  })

  it('kills a busy program on time, through a nested vfork', async () => {
    const { stdout } = await sh(kernel, 'timeout 0.5 awk "BEGIN { while (1) {} }"; echo "status $?"')
    expect(stdout).toBe('Terminated\nstatus 143\n')
  })

  it('reads with a timeout (poll)', async () => {
    const { stdout } = await sh(kernel, '(sleep 0.5; echo later) | { read -t 0.2 a; echo "timed out $?"; read -t 5 b; echo "read $b"; }')
    // 128 + SIGALRM, as bash.
    expect(stdout).toBe('timed out 142\nread later\n')
  })
})
