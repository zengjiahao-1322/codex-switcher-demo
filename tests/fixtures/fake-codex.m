#import <Foundation/Foundation.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  @autoreleasepool {
    for (int i=1; i<argc; i++) if (!strcmp(argv[i], "--version")) {
      const char *log=getenv("SWITCHER_FAKE_CODEX_VERSION_LOG");
      if(log && *log){FILE *file=fopen(log,"a");if(!file){perror(log);return 1;}fputs("version\n",file);fclose(file);}
      puts("codex-fixture 0.1.0"); return 0;
    }
    NSDictionary *environment=[NSProcessInfo processInfo].environment;
    if (environment[@"SWITCHER_FAKE_CODEX_SCENARIO"]) {
      NSTask *task=[[NSTask alloc] init];
      task.launchPath=environment[@"SWITCHER_FIXTURE_NODE"];
      task.arguments=@[environment[@"SWITCHER_FIXTURE_SCRIPT"]];
      task.standardInput=[NSFileHandle fileHandleWithStandardInput];
      task.standardOutput=[NSFileHandle fileHandleWithStandardOutput];
      task.standardError=[NSFileHandle fileHandleWithStandardError];
      [task launch];[task waitUntilExit];return task.terminationStatus;
    }
    NSString *file = [NSProcessInfo processInfo].environment[@"SWITCHER_FAKE_CODEX_RESPONSES"];
    NSDictionary *responses = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:file] options:0 error:NULL];
    char *line = NULL; size_t capacity = 0;
    while (getline(&line, &capacity, stdin) >= 0) {
      NSDictionary *request = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:line] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
      if (!request[@"id"]) continue;
      id result = responses[request[@"method"]];
      NSDictionary *response = result ? @{@"id":request[@"id"], @"result":result} : @{@"id":request[@"id"], @"error":@{@"code":@(-32601),@"message":@"Fixture method unavailable"}};
      NSData *data = [NSJSONSerialization dataWithJSONObject:response options:0 error:NULL];
      fwrite(data.bytes, 1, data.length, stdout); putchar('\n'); fflush(stdout);
    }
    free(line);
  }
  return 0;
}
