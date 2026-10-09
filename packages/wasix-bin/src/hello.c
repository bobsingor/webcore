// The smallest WASIX program: arguments, environment, cwd, pid and exit status.
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
  char cwd[256];
  printf("hello from C: pid %d, ppid %d, cwd %s\n", getpid(), getppid(), getcwd(cwd, sizeof cwd));
  for (int i = 1; i < argc; i++) printf("arg %d: %s\n", i, argv[i]);
  const char *home = getenv("HOME");
  printf("HOME=%s\n", home ? home : "(unset)");
  return argc > 1 ? atoi(argv[argc - 1]) : 0;
}
