// Sleeps until killed (for signal tests).
#include <unistd.h>
int main(void) {
  for (;;) sleep(1);
}
