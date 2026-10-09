// The `webcore` import module: Linux calls that WASIX has no syscall for, so wasix-libc answers
// them from the program's own memory (process groups, the terminal's foreground group, termios,
// file modes) or not at all. webcore's WASIX personality implements these imports on the kernel
// (packages/kernel/src/personalities/wasix). Each returns a result, or a negative errno.
#ifndef WEBCORE_H
#define WEBCORE_H
#include <errno.h>

struct termios;

#define WEBCORE_IMPORT(name) __attribute__((import_module("webcore"), import_name(#name)))

/** `restart`: the handler restarts the syscalls it interrupts (SA_RESTART). */
WEBCORE_IMPORT(sigaction) int __webcore_sigaction(int sig, int disposition, int restart);
WEBCORE_IMPORT(pause) int __webcore_pause(void);
WEBCORE_IMPORT(kill) int __webcore_kill(int pid, int sig);
WEBCORE_IMPORT(wait4) int __webcore_wait4(int pid, int *status, int options);
WEBCORE_IMPORT(setpgid) int __webcore_setpgid(int pid, int pgid);
WEBCORE_IMPORT(getpgid) int __webcore_getpgid(int pid);
WEBCORE_IMPORT(setsid) int __webcore_setsid(void);
WEBCORE_IMPORT(getsid) int __webcore_getsid(int pid);
WEBCORE_IMPORT(tcgetpgrp) int __webcore_tcgetpgrp(int fd);
WEBCORE_IMPORT(tcsetpgrp) int __webcore_tcsetpgrp(int fd, int pgrp);
WEBCORE_IMPORT(tcgetattr) int __webcore_tcgetattr(int fd, struct termios *tio);
WEBCORE_IMPORT(tcsetattr) int __webcore_tcsetattr(int fd, int act, const struct termios *tio);
/** The permission bits of the file the last fd_filestat_get or path_filestat_get described. */
WEBCORE_IMPORT(stat_mode) int __webcore_stat_mode(void);
/** chmod: `path` relative to `dirfd` (negative: the working directory), or `dirfd` itself. */
WEBCORE_IMPORT(chmod) int __webcore_chmod(int dirfd, const char *path, int mode);
WEBCORE_IMPORT(umask) int __webcore_umask(int mask);
/** Times in ms since the epoch: +Infinity is now, NaN leaves one unchanged. */
WEBCORE_IMPORT(utimes) int __webcore_utimes(int dirfd, const char *path, double atime, double mtime, int follow);

static inline int __webcore_result(int result) {
  if (result < 0) {
    errno = -result;
    return -1;
  }
  return result;
}
#endif
