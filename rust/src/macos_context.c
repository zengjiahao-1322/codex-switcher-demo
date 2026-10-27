#include <libproc.h>
#include <string.h>
int switcher_process_cwd(int pid, char *output, int capacity) {
    struct proc_vnodepathinfo info;
    if (proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, sizeof(info)) != sizeof(info)) return 0;
    size_t length = strnlen(info.pvi_cdir.vip_path, sizeof(info.pvi_cdir.vip_path));
    if (length >= (size_t)capacity) return 0;
    memcpy(output, info.pvi_cdir.vip_path, length + 1);
    return (int)length;
}
