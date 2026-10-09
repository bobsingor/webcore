// Terminal calls: isatty, window size, and switching to raw mode and back.
#include <stdio.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

int main(void) {
  printf("isatty: %d %d\n", isatty(0), isatty(1));
  struct winsize size;
  if (ioctl(1, TIOCGWINSZ, &size) == 0) printf("size: %d x %d\n", size.ws_col, size.ws_row);
  else perror("TIOCGWINSZ");
  struct termios saved, raw;
  if (tcgetattr(0, &saved) != 0) { perror("tcgetattr"); return 1; }
  printf("canonical: %d, echo: %d\n", (saved.c_lflag & ICANON) != 0, (saved.c_lflag & ECHO) != 0);
  raw = saved;
  raw.c_lflag &= ~(ICANON | ECHO);
  tcsetattr(0, TCSANOW, &raw);
  printf("press a key: ");
  fflush(stdout);
  char key;
  read(0, &key, 1);
  printf("got '%c'\n", key);
  tcsetattr(0, TCSANOW, &saved);
  return 0;
}
