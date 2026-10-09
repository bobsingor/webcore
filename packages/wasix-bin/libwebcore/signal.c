// Signals. Dispositions live in the kernel, as on Linux: wasix-libc keeps them only in the
// program's memory, so the kernel couldn't tell a shell that ignores SIGTSTP from one that should
// stop, and a vfork child resetting its signals before exec would reset its parent's too (they
// share memory). The kernel learns every change, and a vfork child's changes reach only the
// kernel. sigsuspend and pause, which wasix-libc doesn't implement, wait for a signal.
#include <signal.h>
#include "webcore.h"

#define DISPOSITION_DEFAULT 0
#define DISPOSITION_IGNORE 1
#define DISPOSITION_HANDLE 2
#define IN_VFORK_CHILD 1

int __real___sigaction(int sig, const struct sigaction *restrict sa, struct sigaction *restrict old);

int __wrap___sigaction(int sig, const struct sigaction *restrict sa, struct sigaction *restrict old) {
  if (sa) {
    int disposition = sa->sa_handler == SIG_DFL ? DISPOSITION_DEFAULT
                      : sa->sa_handler == SIG_IGN ? DISPOSITION_IGNORE
                                                  : DISPOSITION_HANDLE;
    int result = __webcore_sigaction(sig, disposition, (sa->sa_flags & SA_RESTART) != 0);
    if (result < 0) return __webcore_result(result);
    if (result == IN_VFORK_CHILD) return __real___sigaction(sig, 0, old);
  }
  return __real___sigaction(sig, sa, old);
}

int __wrap_sigaction(int sig, const struct sigaction *restrict sa, struct sigaction *restrict old) {
  return __wrap___sigaction(sig, sa, old);
}

int __wrap_kill(pid_t pid, int sig) {
  return __webcore_result(__webcore_kill(pid, sig));
}

// Signals reach the program at syscall boundaries, where the personality hands them to libc,
// which runs the handler or, while the signal is blocked, keeps it pending.
int __wrap_sigsuspend(const sigset_t *mask) {
  sigset_t pending, saved;
  // sigpending first delivers what the kernel holds; a blocked signal stays pending in libc.
  sigpending(&pending);
  int ready = 0;
  for (int sig = 1; sig < _NSIG; sig++) {
    if (sigismember(&pending, sig) == 1 && sigismember(mask, sig) != 1) ready = 1;
  }
  // Unblocking runs a ready signal's handler; otherwise wait for the next signal.
  sigprocmask(SIG_SETMASK, mask, &saved);
  if (!ready) __webcore_pause();
  sigprocmask(SIG_SETMASK, &saved, 0);
  errno = EINTR;
  return -1;
}

int __wrap_pause(void) {
  sigset_t mask;
  sigprocmask(SIG_BLOCK, 0, &mask);
  return __wrap_sigsuspend(&mask);
}
