// statfs: WASIX has no filesystem statistics; posix.c fails with ENOSYS.
#ifndef _SYS_STATFS_H
#define _SYS_STATFS_H
#include <sys/types.h>
typedef struct { int __val[2]; } fsid_t;
struct statfs {
  unsigned long f_type, f_bsize;
  unsigned long long f_blocks, f_bfree, f_bavail, f_files, f_ffree;
  fsid_t f_fsid;
  unsigned long f_namelen, f_frsize, f_flags, f_spare[4];
};
int statfs(const char *path, struct statfs *buf);
int fstatfs(int fd, struct statfs *buf);
#endif
