// vfork, nested. wasix-libc's vfork (a setjmp in the caller, then proc_fork_env) keeps one child
// pid and alternates between its two jump buffers, so a vfork child that vforks again (BusyBox's
// timeout, or a NOMMU daemon re-executing itself) returns to the wrong frame when it ends. Here
// the buffers are a stack: each vfork pushes, and each exec or _exit of a child pops back to the
// vfork that started it. Two levels deep at most: the jump buffers are libc's.
#include <errno.h>
#include <setjmp.h>
#include <unistd.h>
#include <wasi/api.h>

static _Thread_local pid_t children[2];

pid_t __wrap___vfork_internal(int setjmp_result) {
  int depth = __vfork_jump_free_index;
  if (setjmp_result) return children[depth];
  if (depth >= 2) {
    errno = EAGAIN;
    return -1;
  }
  __wasi_pid_t pid;
  int error = __wasi_proc_fork_env(&pid);
  if (error) {
    errno = error;
    return -1;
  }
  children[depth] = pid;
  __vfork_jump_free_index = depth + 1;
  return 0;
}

_Noreturn void __wrap___vfork_restore(void) {
  int depth = --__vfork_jump_free_index;
  longjmp(__vfork_jump[depth], 1);
}
