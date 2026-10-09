// POSIX and Linux functions wasix-libc lacks, for ported programs such as BusyBox. Each behaves as
// on a Linux system without the feature: no device nodes, mount table, chroot or clock setting.
#define _GNU_SOURCE
#include <errno.h>
#include <mntent.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/statfs.h>
#include <sys/time.h>
#include <sys/types.h>
#include <webcore/compat.h>

extern char **__wasilibc_environ;
void __wasilibc_ensure_environ(void);

/** `environ` as compat.h defines it: libc's live environment, initialized first. */
char ***__webcore_environ(void) {
  __wasilibc_ensure_environ();
  return &__wasilibc_environ;
}

int sigisemptyset(const sigset_t *set) {
  static const sigset_t empty;
  return memcmp(set, &empty, sizeof empty) == 0;
}

/** poll with a signal mask for its duration: not atomic, which a signal arriving between the
 * mask change and the poll would notice, but the kernel interrupts a poll for a handled signal. */
int ppoll(struct pollfd *fds, nfds_t count, const struct timespec *timeout, const sigset_t *mask) {
  sigset_t saved;
  if (mask) sigprocmask(SIG_SETMASK, mask, &saved);
  int result = poll(fds, count, timeout ? (int)(timeout->tv_sec * 1000 + timeout->tv_nsec / 1000000) : -1);
  if (mask) {
    int error = errno;
    sigprocmask(SIG_SETMASK, &saved, NULL);
    errno = error;
  }
  return result;
}

int getgroups(int size, gid_t list[]) {
  (void)size;
  (void)list;
  return 0;
}

int mknod(const char *path, mode_t mode, dev_t dev) {
  (void)path;
  (void)mode;
  (void)dev;
  errno = EPERM;
  return -1;
}

int settimeofday(const struct timeval *tv, const void *tz) {
  (void)tv;
  (void)tz;
  errno = EPERM;
  return -1;
}

int chroot(const char *path) {
  (void)path;
  errno = EPERM;
  return -1;
}

int fchdir(int fd) {
  (void)fd;
  errno = ENOSYS;
  return -1;
}

int statfs(const char *path, struct statfs *buf) {
  (void)path;
  (void)buf;
  errno = ENOSYS;
  return -1;
}

int fstatfs(int fd, struct statfs *buf) {
  (void)fd;
  (void)buf;
  errno = ENOSYS;
  return -1;
}

FILE *setmntent(const char *path, const char *mode) {
  return fopen(path, mode);
}

struct mntent *getmntent(FILE *file) {
  (void)file;
  return NULL;
}

struct mntent *getmntent_r(FILE *file, struct mntent *entry, char *buf, int size) {
  (void)file;
  (void)entry;
  (void)buf;
  (void)size;
  return NULL;
}

int addmntent(FILE *file, const struct mntent *entry) {
  (void)file;
  (void)entry;
  return 1;
}

int endmntent(FILE *file) {
  if (file) fclose(file);
  return 1;
}

char *hasmntopt(const struct mntent *entry, const char *option) {
  (void)entry;
  (void)option;
  return NULL;
}
