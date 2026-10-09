# 0018. Signals are dispositions in the kernel; terminals are kernel PTYs

- **Status:** Accepted · implemented in M2a; stop and continue in M2c ([0020](0020-wasix-personality.md))
- **Date:** 2026-10-09

## Context

Until M2, `kill` terminated a process on the spot, and every program's stdio was a pipe. An
interactive terminal needs more:
- `^C` must reach a program's `SIGINT` handler, or stop the foreground job and nothing else.
- Programs must see a terminal (`isatty`, window size, raw mode) to show colors, prompts and
  full-screen interfaces.
- A shell must hand the terminal to the job it runs and get it back afterwards.

A process is a Worker. JavaScript running in a Worker can't be interrupted from outside except by
terminating it. Signals therefore can't preempt running code the way they do on Linux.

## Decision

**The kernel keeps a disposition per process and signal: default, ignore, or handle.** The
`sigaction` syscall sets it (SIGKILL and SIGSTOP can't change).
- **Delivering a handled signal** posts `{ t: 'sig', signal }` to the process's message port. It
  runs between tasks, like a libuv signal handle, not mid-instruction.
- **Default actions** follow Linux. Most signals terminate with status 128 + signal. `CHLD`,
  `WINCH`, `URG` and `CONT` are ignored. The stop signals (`TSTP`, `TTIN`, `TTOU`, `STOP`) are
  ignored until job control (M2c).
- Children start with default dispositions.
- Node's `signal_wrap` sets `handle` while any handle listens, and back to `default` when the last
  one stops, so `process.on('SIGINT')` behaves as in Node.

**Pseudo-terminals live in the kernel.** `openpty` creates a master/slave pair. The slave is a
terminal; the master is the terminal emulator's end. Between them sits a subset of Linux's line
discipline (n_tty): canonical editing, echo with `ECHOCTL`, `ONLCR`, `^C`/`^\`/`^Z` as signals to
the foreground process group, `VMIN`/`VTIME`, window size with `SIGWINCH`, and hang-up when the
master closes. A program asks for and changes terminal state through an `ioctl` syscall in Linux's
numbering (`TCGETS`, `TCSETS`, `TIOCGWINSZ`, `TIOCSPGRP`, …), with termios as an object.

**Sessions and process groups follow Linux.**
- `setsid`, `setpgid` and `getsid`, and spawn options that place a child in a new or given group.
- A session leader's controlling terminal and its foreground group decide where `^C` goes.
- When the session leader exits, the foreground job gets `SIGHUP`.
- A read from the terminal by a process outside the foreground group waits until its group is in
  the foreground. Linux would stop it with `SIGTTIN`; waiting gives the same result without
  stopping Workers. A shell's pending read thereby never takes input meant for its job.

**The shell does job control the usual way.** Each pipeline runs in its own process group, which
gets the terminal with `TIOCSPGRP`. The shell ignores `SIGINT`, and switches the terminal to raw
mode only while it reads a line, as bash's readline does.

## Consequences

- `^C` stops jobs and reaches handlers. Node's REPL, readline, `isTTY`, colors and resize events
  work. Vite's keyboard shortcuts work too.
- **A busy loop can't be interrupted by a handled signal.** The handler runs once the code yields.
  Default actions still terminate at once, since the kernel ends the Worker.
- **There is no real stop or continue yet.** Pausing a Worker isn't possible. `^Z`, `bg` and `fg`
  need a different mechanism (M2c), for example processes that check in at syscalls.
- The ABI gains Linux's terminal requests, so WASIX programs (bash, M2c) can use the same
  terminals through structs instead of objects.
- `SIGPIPE` isn't raised yet: writing to a closed pipe fails with `EPIPE` only.

## Alternatives considered

- **Terminals in the host** (the SDK or the playground interpreting keys). Every program would see
  the host's idea of a terminal, and a shell, Node's REPL and a WASI program couldn't share one
  terminal the way they share fds.
- **Signals as SharedArrayBuffer flags that programs poll.** This would allow interrupting busy
  loops in code that checks the flag, but nothing in Node's `lib/` or in WASI programs does. It
  could still back `Atomics`-based interrupts later.
- **Stopping background readers with `SIGTTIN`.** It needs stop/continue, which doesn't exist yet.
  Waiting gives the same observable behaviour for a shell and its jobs.
