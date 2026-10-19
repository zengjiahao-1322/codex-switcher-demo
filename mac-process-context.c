#include <errno.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <unistd.h>

/* 只输出归属判断需要的字段，不输出完整命令行或其他环境变量。 */
static void print_json_string(const char *text) {
    putchar('"');
    const unsigned char *cursor = (const unsigned char *)(text ? text : "");
    for (; *cursor; cursor++) {
        switch (*cursor) {
            case '"': fputs("\\\"", stdout); break;
            case '\\': fputs("\\\\", stdout); break;
            case '\n': fputs("\\n", stdout); break;
            case '\r': fputs("\\r", stdout); break;
            case '\t': fputs("\\t", stdout); break;
            default:
                if (*cursor < 32) printf("\\u%04x", *cursor);
                else putchar(*cursor);
        }
    }
    putchar('"');
}

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    pid_t pid = (pid_t)atoi(argv[1]);

    /* 部分 macOS 版本不支持对 KERN_PROCARGS2 传空缓冲区查询大小。
       先读取系统的 KERN_ARGMAX，再取得目标进程参数与环境。 */
    int argmax = 0;
    int max_mib[] = {CTL_KERN, KERN_ARGMAX};
    size_t max_size = sizeof(argmax);
    if (sysctl(max_mib, 2, &argmax, &max_size, NULL, 0) != 0 || argmax <= 0) return 1;

    int mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
    size_t size = (size_t)argmax;
    char *buffer = calloc(size + 1, 1);
    if (!buffer) return 1;
    if (sysctl(mib, 3, buffer, &size, NULL, 0) != 0) {
        int error = errno;
        free(buffer);
        printf("{\"ok\":false,\"error\":\"%s\"}\n",
               error == ESRCH ? "process_exited" : "process_access_denied");
        return 0;
    }

    int argument_count = 0;
    memcpy(&argument_count, buffer, sizeof(int));
    if (argument_count < 1 || argument_count > argmax / (int)sizeof(char *)) {
        free(buffer);
        return 1;
    }
    char *cursor = buffer + sizeof(int);
    char *end = buffer + size;

    /* 布局依次为 argc、可执行路径、空字节、argv、环境变量。 */
    cursor += strnlen(cursor, end - cursor) + 1;
    while (cursor < end && !*cursor) cursor++;
    char **arguments = calloc((size_t)argument_count + 1, sizeof(char *));
    if (!arguments) {
        free(buffer);
        return 1;
    }
    for (int i = 0; i < argument_count && cursor < end; i++) {
        arguments[i] = cursor;
        cursor += strnlen(cursor, end - cursor) + 1;
    }

    char *codex_home = NULL;
    char *user_home = NULL;
    char *window_hook = NULL;
    while (cursor < end) {
        size_t length = strnlen(cursor, end - cursor);
        if (!length) {
            cursor++;
            continue;
        }
        if (!strncmp(cursor, "CODEX_HOME=", 11)) codex_home = cursor + 11;
        else if (!strncmp(cursor, "HOME=", 5)) user_home = cursor + 5;
        else if (!strncmp(cursor, "VSCODE_IPC_HOOK_CLI=", 20)) window_hook = cursor + 20;
        cursor += length + 1;
    }

    char cwd[PROC_PIDPATHINFO_MAXSIZE] = {0};
    struct proc_vnodepathinfo info;
    if (proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, sizeof(info)) == (int)sizeof(info)) {
        snprintf(cwd, sizeof(cwd), "%s", info.pvi_cdir.vip_path);
    }

    /* 相对 CODEX_HOME 依据目标进程的工作目录解析，而不是切换器自己的目录。 */
    char resolved_home[PROC_PIDPATHINFO_MAXSIZE] = {0};
    const char *home_source = "default";
    if (codex_home && *codex_home) {
        home_source = "CODEX_HOME";
        if (codex_home[0] == '/') snprintf(resolved_home, sizeof(resolved_home), "%s", codex_home);
        else if (*cwd) snprintf(resolved_home, sizeof(resolved_home), "%s/%s", cwd, codex_home);
    } else if (user_home) {
        snprintf(resolved_home, sizeof(resolved_home), "%s/.codex", user_home);
    }

    printf("{\"ok\":%s,\"home\":", *resolved_home ? "true" : "false");
    if (*resolved_home) print_json_string(resolved_home);
    else fputs("null", stdout);
    fputs(",\"homeSource\":", stdout);
    print_json_string(home_source);
    fputs(",\"cwd\":", stdout);
    print_json_string(cwd);
    fputs(",\"windowKey\":", stdout);
    if (window_hook) print_json_string(window_hook);
    else fputs("null", stdout);

    char *profile = NULL;
    for (int i = 1; i < argument_count && arguments[i]; i++) {
        if ((!strcmp(arguments[i], "--profile") || !strcmp(arguments[i], "-p")) && i + 1 < argument_count) {
            profile = arguments[++i];
        } else if (!strncmp(arguments[i], "--profile=", 10)) {
            profile = arguments[i] + 10;
        }
    }
    if (profile) {
        fputs(",\"profile\":", stdout);
        print_json_string(profile);
    }

    /* 只保留模型选择相关覆盖项；其他 -c 参数可能含密钥，不予输出。 */
    fputs(",\"overrides\":{", stdout);
    int emitted = 0;
    for (int i = 1; i < argument_count && arguments[i]; i++) {
        char *value = NULL;
        char *key = NULL;
        if ((!strcmp(arguments[i], "--model") || !strcmp(arguments[i], "-m")) && i + 1 < argument_count) {
            key = "model";
            value = arguments[++i];
        } else if (!strncmp(arguments[i], "--model=", 8)) {
            key = "model";
            value = arguments[i] + 8;
        } else if ((!strcmp(arguments[i], "--config") || !strcmp(arguments[i], "-c")) && i + 1 < argument_count) {
            value = arguments[++i];
        } else if (!strncmp(arguments[i], "--config=", 9)) {
            value = arguments[i] + 9;
        }
        if (value && !key) {
            char *equals = strchr(value, '=');
            if (equals) {
                size_t length = (size_t)(equals - value);
                if ((length == 5 && !strncmp(value, "model", length)) ||
                    (length == 14 && !strncmp(value, "model_provider", length)) ||
                    (length == 18 && !strncmp(value, "model_catalog_json", length))) {
                    *equals = 0;
                    key = value;
                    value = equals + 1;
                }
            }
        }
        if (key && value) {
            if (emitted++) putchar(',');
            print_json_string(key);
            putchar(':');
            print_json_string(value);
        }
    }
    fputs("}}\n", stdout);
    free(arguments);
    free(buffer);
    return 0;
}
