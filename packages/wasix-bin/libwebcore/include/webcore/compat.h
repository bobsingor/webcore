// Declarations Linux headers have and the WASIX sysroot doesn't. Included before every source file
// of a ported program (-include webcore/compat.h); the functions are in posix.c.
#if !defined(WEBCORE_COMPAT_H) && !defined(__ASSEMBLER__)
#define WEBCORE_COMPAT_H
#include <signal.h>
#include <sys/types.h>

#define SOCK_RDM 4

// wasix-libc has two `environ`s: musl's, which a program may link, and __wasilibc_environ, which
// putenv and setenv update and exec passes on (initialized on first use). A shell's exports must
// show in its children and in its own built-in applets alike.
char ***__webcore_environ(void);
#define environ (*__webcore_environ())

struct timeval;
int sigisemptyset(const sigset_t *set);
int getgroups(int size, gid_t list[]);
int mknod(const char *path, mode_t mode, dev_t dev);
int settimeofday(const struct timeval *tv, const void *tz);
int chroot(const char *path);
int fchdir(int fd);
#endif
