/* Loaded only in isolated unsigned test backends. Interpose a single TEMP
   fixture PID from a marker; all unrelated process operations call libc. */
#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
static int fixture_kill(pid_t pid,int sig) {
    const char *file=getenv("SWITCHER_FIXTURE_PROCESS_DENY");
    int target=0,query=0;
    if(file) {
        FILE *input=fopen(file,"r");
        if(input) { if(fscanf(input,"%d %d",&target,&query)!=2)target=0; fclose(input); }
    }
    if(target>0&&pid==target&&(sig!=0||query)) {errno=EPERM;return -1;}
    int (*real_kill)(pid_t,int)=dlsym(RTLD_NEXT,"kill");
    return real_kill(pid,sig);
}
__attribute__((used)) static struct {const void *replacement;const void *original;} interpose
__attribute__((section("__DATA,__interpose")))={(void *)fixture_kill,(void *)kill};
