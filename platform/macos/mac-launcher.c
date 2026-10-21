#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* 使用真正的 Mach-O 主程序，让 .app 可以携带可验证的完整代码签名。 */
int main(int argc, char **argv) {
    char executable[PATH_MAX];
    uint32_t size = sizeof(executable);
    if (_NSGetExecutablePath(executable, &size) != 0) {
        fputs("Application path is too long\n", stderr);
        return 1;
    }

    char *last_slash = strrchr(executable, '/');
    if (last_slash == NULL) return 1;
    *last_slash = '\0';

    char script[PATH_MAX];
    if (snprintf(script, sizeof(script), "%s/../Resources/platform/macos/mac-launcher.sh", executable)
        >= (int)sizeof(script)) return 1;

    /* 直接传递参数，不经过字符串拼接执行；应用路径可以包含空格。 */
    char *arguments[argc + 2];
    arguments[0] = "/bin/bash";
    arguments[1] = script;
    for (int i = 1; i < argc; i++) arguments[i + 1] = argv[i];
    arguments[argc + 1] = NULL;
    execv(arguments[0], arguments);
    perror("Cannot start Codex Switcher");
    return 1;
}
