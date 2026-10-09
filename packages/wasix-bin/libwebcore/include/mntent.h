// Mount tables: WASIX has none. The functions are in posix.c and find no mounts.
#ifndef _MNTENT_H
#define _MNTENT_H
#include <stdio.h>
#define MOUNTED "/etc/mtab"
struct mntent {
  char *mnt_fsname;
  char *mnt_dir;
  char *mnt_type;
  char *mnt_opts;
  int mnt_freq;
  int mnt_passno;
};
FILE *setmntent(const char *path, const char *mode);
struct mntent *getmntent(FILE *file);
struct mntent *getmntent_r(FILE *file, struct mntent *entry, char *buf, int size);
int addmntent(FILE *file, const struct mntent *entry);
int endmntent(FILE *file);
char *hasmntopt(const struct mntent *entry, const char *option);
#endif
