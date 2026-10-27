// Darwin's directory FSEvents coalesces notifications. kqueue observes the
// actual temporary-file creation from a separate test process.
#include <sys/event.h>
#include <sys/time.h>
#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 5) return 2;
  int directory = open(argv[1], O_RDONLY);
  int queue = kqueue();
  if (directory < 0 || queue < 0) return 3;
  struct kevent change, event;
  EV_SET(&change, directory, EVFILT_VNODE, EV_ADD | EV_CLEAR,
         NOTE_WRITE | NOTE_EXTEND | NOTE_RENAME, 0, NULL);
  if (kevent(queue, &change, 1, NULL, 0, NULL) < 0) return 4;
  puts("ready");
  fflush(stdout);
  struct timespec timeout = {20, 0};
  while (kevent(queue, NULL, 0, &event, 1, &timeout) > 0) {
    DIR *scan = opendir(argv[1]);
    if (!scan) return 5;
    int found = 0;
    struct dirent *entry;
    while ((entry = readdir(scan))) {
      size_t n = strlen(entry->d_name), prefix = strlen(argv[2]);
      if (n > prefix + 4 && !strncmp(entry->d_name, argv[2], prefix) &&
          !strcmp(entry->d_name + n - 4, ".tmp")) {
        found = 1;
        break;
      }
    }
    closedir(scan);
    if (!found) continue;
    int target = open(argv[3], O_WRONLY | O_TRUNC);
    const char text[] = "model=\"external\"\n";
    if (target < 0 || write(target, text, sizeof(text) - 1) != sizeof(text) - 1)
      return 6;
    if (fsync(target) || close(target)) return 7;
    int marker = open(argv[4], O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (marker < 0 || close(marker)) return 8;
    close(queue);
    close(directory);
    return 0;
  }
  return 9;
}
