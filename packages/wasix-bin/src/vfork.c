// vfork, exec and waitpid, as a shell uses them: a child with redirected stdout runs a program,
// another child exits directly, and the parent reads the pipe and collects both statuses.
#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

int main(int argc, char **argv) {
  const char *program = argc > 1 ? argv[1] : "/usr/bin/hello";
  int fds[2];
  if (pipe(fds) != 0) { perror("pipe"); return 1; }
  pid_t child = vfork();
  if (child == 0) {
    dup2(fds[1], 1);
    close(fds[0]);
    close(fds[1]);
    char *args[] = { (char *)program, "from", "vfork", "3", NULL };
    execve(program, args, environ);
    _exit(127);
  }
  close(fds[1]);
  char buf[512];
  ssize_t n, total = 0;
  while ((n = read(fds[0], buf + total, sizeof buf - 1 - total)) > 0) total += n;
  buf[total] = 0;
  int status;
  pid_t waited = waitpid(child, &status, 0);
  printf("exec child %s: exited %d\n", waited == child ? "reaped" : "missing", WIFEXITED(status) ? WEXITSTATUS(status) : -1);
  printf("it wrote: %s", buf);

  pid_t quitter = vfork();
  if (quitter == 0) _exit(5);
  waitpid(quitter, &status, 0);
  printf("_exit child: exited %d\n", WEXITSTATUS(status));

  pid_t spawned;
  char *args[] = { (char *)program, "spawned", NULL };
  int error = posix_spawn(&spawned, program, NULL, NULL, args, environ);
  if (error) { printf("posix_spawn: %s\n", strerror(error)); return 1; }
  waitpid(spawned, &status, 0);
  printf("posix_spawn child: exited %d\n", WEXITSTATUS(status));

  pid_t missing = vfork();
  if (missing == 0) {
    char *none[] = { "/no/such/program", NULL };
    execve(none[0], none, environ);
    _exit(errno == ENOENT ? 127 : 126);
  }
  waitpid(missing, &status, 0);
  printf("missing program: exited %d\n", WEXITSTATUS(status));
  return 0;
}
