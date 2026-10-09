// Who and where a program runs: user 1000 on host webcore, as Node's os and process modules say
// in webcore. wasix-libc answers uid 0 and a wasmer host name.
#include <string.h>
#include <sys/types.h>
#include <sys/utsname.h>

#define USER_ID 1000

uid_t __wrap_getuid(void) { return USER_ID; }
uid_t __wrap_geteuid(void) { return USER_ID; }
gid_t __wrap_getgid(void) { return USER_ID; }
gid_t __wrap_getegid(void) { return USER_ID; }

int __wrap_uname(struct utsname *name) {
  memset(name, 0, sizeof *name);
  strcpy(name->sysname, "Linux");
  strcpy(name->nodename, "webcore");
  strcpy(name->release, "6.0.0-webcore");
  strcpy(name->version, "#1 SMP webcore");
  strcpy(name->machine, "wasm32");
  return 0;
}
