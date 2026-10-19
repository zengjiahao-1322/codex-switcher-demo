#include <sys/types.h>
#include <sys/sysctl.h>
#include <libproc.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Read only the configuration fields needed to associate a local Codex process. */
static void json(const char *s){putchar('"');for(const unsigned char *p=(const unsigned char *)(s?s:"");*p;p++){switch(*p){case '"':fputs("\\\"",stdout);break;case '\\':fputs("\\\\",stdout);break;case '\n':fputs("\\n",stdout);break;case '\r':fputs("\\r",stdout);break;case '\t':fputs("\\t",stdout);break;default:if(*p<32)printf("\\u%04x",*p);else putchar(*p);}}putchar('"');}
int main(int argc,char **argv){
 if(argc!=2)return 2;pid_t pid=(pid_t)atoi(argv[1]);
 int mib[]={CTL_KERN,KERN_PROCARGS2,pid};size_t size=0;
 if(sysctl(mib,3,NULL,&size,NULL,0)!=0||size<sizeof(int)){puts("{\"ok\":false,\"error\":\"process_access_denied_or_exited\"}");return 0;}
 char *buffer=calloc(size+1,1);if(!buffer)return 1;
 if(sysctl(mib,3,buffer,&size,NULL,0)!=0){free(buffer);puts("{\"ok\":false,\"error\":\"process_access_denied_or_exited\"}");return 0;}
 int count=0;memcpy(&count,buffer,sizeof(int));char *p=buffer+sizeof(int),*end=buffer+size;
 p+=strnlen(p,end-p)+1;while(p<end&&!*p)p++;
 char **args=calloc((size_t)count+1,sizeof(char *));if(!args){free(buffer);return 1;}
 for(int i=0;i<count&&p<end;i++){args[i]=p;p+=strnlen(p,end-p)+1;}
 char *home=NULL,*user=NULL,*hook=NULL;
 while(p<end){size_t n=strnlen(p,end-p);if(!n){p++;continue;}if(!strncmp(p,"CODEX_HOME=",11))home=p+11;else if(!strncmp(p,"HOME=",5))user=p+5;else if(!strncmp(p,"VSCODE_IPC_HOOK_CLI=",20))hook=p+20;p+=n+1;}
 char cwd[PROC_PIDPATHINFO_MAXSIZE]={0};struct proc_vnodepathinfo info;
 if(proc_pidinfo(pid,PROC_PIDVNODEPATHINFO,0,&info,sizeof(info))==(int)sizeof(info))snprintf(cwd,sizeof(cwd),"%s",info.pvi_cdir.vip_path);
 char resolved[PROC_PIDPATHINFO_MAXSIZE]={0};const char *source="default";
 if(home&&*home){source="CODEX_HOME";if(home[0]=='/')snprintf(resolved,sizeof(resolved),"%s",home);else if(*cwd)snprintf(resolved,sizeof(resolved),"%s/%s",cwd,home);}else if(user)snprintf(resolved,sizeof(resolved),"%s/.codex",user);
 printf("{\"ok\":%s,\"home\":",*resolved?"true":"false");if(*resolved)json(resolved);else fputs("null",stdout);
 fputs(",\"homeSource\":",stdout);json(source);fputs(",\"cwd\":",stdout);json(cwd);fputs(",\"windowKey\":",stdout);if(hook)json(hook);else fputs("null",stdout);
 char *profile=NULL;for(int i=1;i<count;i++){if(!args[i])break;if((!strcmp(args[i],"--profile")||!strcmp(args[i],"-p"))&&i+1<count)profile=args[++i];else if(!strncmp(args[i],"--profile=",10))profile=args[i]+10;}
 if(profile){fputs(",\"profile\":",stdout);json(profile);}fputs(",\"overrides\":{",stdout);int emitted=0;
 for(int i=1;i<count;i++){if(!args[i])break;char *value=NULL,*key=NULL;if((!strcmp(args[i],"--model")||!strcmp(args[i],"-m"))&&i+1<count){key="model";value=args[++i];}else if(!strncmp(args[i],"--model=",8)){key="model";value=args[i]+8;}else if((!strcmp(args[i],"--config")||!strcmp(args[i],"-c"))&&i+1<count)value=args[++i];else if(!strncmp(args[i],"--config=",9))value=args[i]+9;
  if(value&&!key){char *eq=strchr(value,'=');if(eq){size_t n=(size_t)(eq-value);if((n==5&&!strncmp(value,"model",n))||(n==14&&!strncmp(value,"model_provider",n))||(n==18&&!strncmp(value,"model_catalog_json",n))){*eq=0;key=value;value=eq+1;}}}
  if(key&&value){if(emitted++)putchar(',');json(key);putchar(':');json(value);}
 }
 fputs("}}\n",stdout);free(args);free(buffer);return 0;
}
