// File modes, owners and times. WASI's filestat has no permission bits, and wasix-libc's chmod and
// umask do nothing; the kernel has them. stat reports the mode the personality saw in the same
// call. wasix-libc's utimensat rejects UTIME_NOW, and its utimes(path, NULL) sets 1970.
#include <fcntl.h>
#include <math.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <utime.h>
#include "webcore.h"

int __real_fstat(int fd, struct stat *st);
int __real___wasilibc_nocwd_fstatat(int dirfd, const char *restrict path, struct stat *restrict st, int flags);

static int with_mode(int result, struct stat *st) {
  if (result == 0) {
    st->st_mode = (st->st_mode & S_IFMT) | (__webcore_stat_mode() & 07777);
    // Every file belongs to the one user (identity.c).
    st->st_uid = 1000;
    st->st_gid = 1000;
  }
  return result;
}

int __wrap_fstat(int fd, struct stat *st) {
  return with_mode(__real_fstat(fd, st), st);
}

int __wrap___wasilibc_nocwd_fstatat(int dirfd, const char *restrict path, struct stat *restrict st, int flags) {
  return with_mode(__real___wasilibc_nocwd_fstatat(dirfd, path, st, flags), st);
}

mode_t __wrap_umask(mode_t mask) {
  return __webcore_umask(mask & 0777);
}

static double ms(const struct timespec *time) {
  if (!time || time->tv_nsec == UTIME_NOW) return INFINITY;
  if (time->tv_nsec == UTIME_OMIT) return NAN;
  return time->tv_sec * 1000.0 + time->tv_nsec / 1e6;
}

int __wrap_utimensat(int dirfd, const char *path, const struct timespec times[2], int flags) {
  return __webcore_result(__webcore_utimes(dirfd == AT_FDCWD ? -1 : dirfd, path, ms(times ? &times[0] : 0),
                                           ms(times ? &times[1] : 0), !(flags & AT_SYMLINK_NOFOLLOW)));
}

int __wrap_futimens(int fd, const struct timespec times[2]) {
  return __webcore_result(__webcore_utimes(fd, 0, ms(times ? &times[0] : 0), ms(times ? &times[1] : 0), 1));
}

int __wrap_utimes(const char *path, const struct timeval times[2]) {
  if (!times) return __webcore_result(__webcore_utimes(-1, path, INFINITY, INFINITY, 1));
  return __webcore_result(__webcore_utimes(-1, path, times[0].tv_sec * 1000.0 + times[0].tv_usec / 1e3,
                                           times[1].tv_sec * 1000.0 + times[1].tv_usec / 1e3, 1));
}

int __wrap_utime(const char *path, const struct utimbuf *times) {
  if (!times) return __webcore_result(__webcore_utimes(-1, path, INFINITY, INFINITY, 1));
  return __webcore_result(__webcore_utimes(-1, path, times->actime * 1000.0, times->modtime * 1000.0, 1));
}

int __wrap_chmod(const char *path, mode_t mode) {
  return __webcore_result(__webcore_chmod(-1, path, mode));
}

int __wrap_fchmod(int fd, mode_t mode) {
  return __webcore_result(__webcore_chmod(fd, 0, mode));
}

int __wrap_fchmodat(int dirfd, const char *path, mode_t mode, int flags) {
  (void)flags;
  return __webcore_result(__webcore_chmod(dirfd == AT_FDCWD ? -1 : dirfd, path, mode));
}
