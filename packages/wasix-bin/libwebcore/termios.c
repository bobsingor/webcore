// The terminal: all of termios and the foreground process group, on the kernel's terminal.
// wasix-libc maps termios onto WASIX's tty state, which keeps only echo and line buffering, and
// keeps the foreground group in memory.
#include <stddef.h>
#include <termios.h>
#include <unistd.h>
#include "webcore.h"

_Static_assert(sizeof(struct termios) == 60 && offsetof(struct termios, c_cc) == 17, "termios layout");

int __wrap_tcgetattr(int fd, struct termios *tio) {
  return __webcore_result(__webcore_tcgetattr(fd, tio));
}

int __wrap_tcsetattr(int fd, int act, const struct termios *tio) {
  if (act < TCSANOW || act > TCSAFLUSH) {
    errno = EINVAL;
    return -1;
  }
  return __webcore_result(__webcore_tcsetattr(fd, act, tio));
}

pid_t __wrap_tcgetpgrp(int fd) {
  return __webcore_result(__webcore_tcgetpgrp(fd));
}

int __wrap_tcsetpgrp(int fd, pid_t pgrp) {
  return __webcore_result(__webcore_tcsetpgrp(fd, pgrp));
}
