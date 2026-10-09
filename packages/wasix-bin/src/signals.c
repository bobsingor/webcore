// Signal handlers, ignoring, and kill between processes.
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t got = 0;
static void on_usr1(int sig) { got = sig; }

int main(void) {
  struct sigaction action;
  memset(&action, 0, sizeof action);
  action.sa_handler = on_usr1;
  sigaction(SIGUSR1, &action, NULL);
  kill(getpid(), SIGUSR1);
  // Delivery happens at a syscall boundary.
  for (int i = 0; i < 100 && !got; i++) usleep(1000);
  printf("handler ran: %s\n", got == SIGUSR1 ? "yes" : "no");

  signal(SIGINT, SIG_IGN);
  kill(getpid(), SIGINT);
  usleep(1000);
  printf("survived an ignored SIGINT\n");

  pid_t child = vfork();
  if (child == 0) {
    char *args[] = { "/usr/bin/sleepy", NULL };
    execv("/usr/bin/sleepy", args);
    _exit(127);
  }
  usleep(20000);
  kill(child, SIGTERM);
  int status;
  waitpid(child, &status, 0);
  printf("child: %s %d\n", WIFSIGNALED(status) ? "killed by signal" : "exited", WIFSIGNALED(status) ? WTERMSIG(status) : WEXITSTATUS(status));
  return 0;
}
