// Processes: groups, sessions and waiting, as Linux has them (wasix-libc keeps one process group
// number in memory and has no sessions; job control needs the kernel's), and exec.
#include <sys/types.h>
#include <unistd.h>
#include "webcore.h"

char ***__webcore_environ(void);

// wasix-libc's execv passes no environment, so the new program would get the one this program
// started with, without what it exported since.
int __wrap_execv(const char *path, char *const argv[]) {
  return execve(path, argv, *__webcore_environ());
}

pid_t __wrap_waitpid(pid_t pid, int *status, int options) {
  int code = 0;
  int result = __webcore_wait4(pid, &code, options);
  if (result > 0 && status) *status = code;
  return __webcore_result(result);
}

int __wrap_setpgid(pid_t pid, pid_t pgid) {
  return __webcore_result(__webcore_setpgid(pid, pgid));
}

pid_t __wrap_getpgid(pid_t pid) {
  return __webcore_result(__webcore_getpgid(pid));
}

pid_t __wrap_getpgrp(void) {
  return __webcore_result(__webcore_getpgid(0));
}

pid_t __wrap_setsid(void) {
  return __webcore_result(__webcore_setsid());
}

pid_t __wrap_getsid(pid_t pid) {
  return __webcore_result(__webcore_getsid(pid));
}
