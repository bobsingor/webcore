# 0020. WASIX programs are kernel processes: vfork without fork, signals between syscalls

- **Status:** Accepted · implemented in M2c
- **Date:** 2026-10-09

## Context

M2c needs a real shell and the usual Unix commands, as C programs compiled to WebAssembly. WASIX
([0004](0004-wasi-and-wasix-abi.md)) is the ABI with a libc and a toolchain for that (wasixcc,
wasix-libc). Three things shape how webcore runs it:

- **No fork.** A Worker's memory can't be copied into a second Worker mid-call. WASIX's `fork()`
  needs Asyncify, which rewrites the whole program to unwind and rewind its stack: larger, slower
  binaries, and a toolchain variant of its own.
- **Signals and job control.** A process blocks inside synchronous syscalls (ADR-0002) and never
  returns to an event loop, so a message on its port, as Node processes get signals
  ([0018](0018-signals-and-terminals.md)), would never be read.
- **wasix-libc keeps much of Linux in the program's own memory.** Signal dispositions, the process
  group, the terminal's foreground group and most of termios live in libc variables; `sigsuspend`
  does nothing; file modes don't exist. A shell needs all of them to be the kernel's.

## Decision

**A C toolchain in the build.** `@webcore/wasix-bin` downloads wasixcc, its LLVM, the WASIX
sysroot and binaryen at pinned versions, and builds BusyBox from pinned, checksummed source. It
uses the exception-handling sysroot: `setjmp`/`longjmp` are Wasm exceptions, with no Asyncify.

**vfork, not fork.** In that sysroot `vfork()` is a `setjmp` plus `proc_fork_env`. The kernel's
`vfork` syscall creates the child (a copy of the fd table, working directory, umask and signal
dispositions), and the thread then acts as the child: its syscalls apply to the child, which runs
on the parent's memory and stack. `execve` starts the new program in a Worker of the child's own
and returns in the parent; `vforkExit` ends the child; libc then `longjmp`s back to `vfork` in the
parent. BusyBox is built for systems without an MMU, which need nothing more: hush runs commands
with vfork and exec, and re-executes itself where a fork would continue.

**The WASI personality runs WASIX programs.**
- **Fds are the kernel's.** A program's fd 5 is the process's fd 5, so `exec 3<file`, `dup2` and
  inheritance across exec mean what they do on Linux. `/` is preopened as a virtual fd just past
  the kernel's range, which no program can close or replace; libc's preopen scan skips every fd
  below it. (node:wasi keeps its own table, since its module shares a Node process.)
- **The program imports a shared memory**, which the process creates from limits the kernel reads
  in the module's import section (reserving at most 1 GiB).
- **WASIX's calls map onto kernel syscalls:** `proc_fork_env`, `proc_exec4`, `proc_exit2`,
  `proc_spawn3` (posix_spawn as vfork, file actions, exec), `proc_join` (wait4), `proc_signal`,
  `fd_dup`/`fd_dup2`/`fd_fdflags_*` (FD_CLOEXEC, closed by execve), `fd_pipe`, `path_open2`,
  `getcwd`/`chdir`, `tty_get`/`tty_set`, futexes, and `poll_oneoff` on a kernel `poll` that waits
  for pipes, terminals and sockets to become ready.

**libwebcore fills in the rest.** Every program webcore builds links a small library that
replaces (with `--wrap`) the libc functions WASIX answers from memory: `sigaction`, `sigsuspend`,
`pause`, `kill`, `waitpid`, `setpgid`/`getpgid`/`setsid`/`getsid`, `tcgetattr`/`tcsetattr`,
`tcgetpgrp`/`tcsetpgrp`, `stat` modes, `chmod`, `umask`, the `utime` family, `getuid` and
`uname`. They call the kernel through imports from a `webcore` module, which the personality
implements. libwebcore also fixes what would otherwise break BusyBox: nested vfork, `execv`
without the current environment, and `utimensat` with `UTIME_NOW`. Prebuilt WASIX binaries
without libwebcore still run, with WASIX's own semantics.

**Signals arrive between syscalls.** The syscall page gains a doorbell word.
- **Handled signals** for a WASI process queue in the kernel, which rings the doorbell and
  interrupts the syscall the process is blocked in (`EINTR`). After every import call, and in
  sleeps (which wait on the doorbell), the process checks it, takes its signals and calls the
  handler libc registered.
- **`SA_RESTART`:** a call that a restarting handler interrupted fails with an internal
  `ERESTARTSYS`, and the process makes it again after the handler ran, as on Linux. `poll` and
  `pause` always fail with `EINTR`.
- **Dispositions are the kernel's** (libwebcore reports each change), so the kernel can ignore,
  stop and terminate without the program's help. A vfork child's changes reach only the kernel,
  since its parent's handler table is the same memory.

**Job control is held syscalls.** The default action of `SIGTSTP`, `SIGTTIN`, `SIGTTOU` and
`SIGSTOP` stops a process: the kernel rings its doorbell and holds every syscall it makes until
`SIGCONT`. `wait4` reports stopped and continued children (`WUNTRACED`, `WCONTINUED`), and the
parent gets `SIGCHLD`. Node processes stop the same way, at their next syscall.

## Consequences

- **BusyBox is the shell and the commands.** hush is `/bin/sh` with line editing, history, tab
  completion and job control (`^Z`, `fg`, `bg`, `jobs`). A hundred applets come with it, among them
  `ls`, `grep`, `sed`, `awk`, `find`, `xargs`, `tar`, `gzip`, `diff`, `vi` and `less`. The
  TypeScript `sh`, the host-side mini shell and the hand-written WAT programs are gone.
- Starting a program costs a Worker and an instantiation: about 40 ms with warm Workers. hush runs
  its built-in applets (`echo`, `test`, `printf`, …) in its own process.
- **A busy loop can still only be stopped or killed, not interrupted** by a handled signal: the
  handler runs at the program's next syscall. Default actions take effect at once.
- vfork nests two levels deep (libc keeps two jump buffers), which covers BusyBox. A vfork child
  must not return from the function that called `vfork`, as on any system without an MMU.
- Programs see one user: uid 1000 owns every file. Modes, times and umask are real.
- The build downloads about 750 MB of toolchain once, into `node_modules/.cache`. BusyBox takes a
  minute to build; nothing rebuilds while its inputs are unchanged.

## Alternatives considered

- **fork through Asyncify** (WASIX's approach). Every function on a path to fork grows unwind and
  rewind code, binaries get larger and slower, and fork copies the whole memory. It would allow
  bash, which needs a real fork; it can come later, for programs that need it.
- **bash, or BusyBox's ash.** Both need fork. No maintained WASIX port of either exists.
- **Building wasix-libc from source with fixes.** It would avoid the wrappers, but would make the
  repo own a libc build. libwebcore is about 500 lines, uses only the linker's `--wrap`, and
  survives sysroot upgrades as long as the wrapped functions keep their names.
- **A translated fd table, as node:wasi has.** Programs couldn't pass fds to each other by number
  (`cmd 3>file`), and exec would have to rebuild the mapping.
- **Signals as messages, as Node processes get them.** A WASI process never reads its port while it
  runs, so nothing would arrive.
