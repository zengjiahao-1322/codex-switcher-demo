'use strict';

const cp = require('node:child_process');

// 调用方先确认配置归属；这里只停止传入的 PID，不扩展到整个编辑器或其他窗口。
async function stopProcesses(ids) {
  const signal = (pid, name) => {
    try {
      process.kill(pid, name);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      if (process.platform === 'darwin') {
        // 父进程尚未回收的 zombie 已没有可执行代码，不应阻塞新配置接管。
        let state;
        try {
          state = cp
            .execFileSync('/bin/ps', ['-o', 'state=', '-p', String(pid)], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            })
            .trim();
        } catch {
          // PID 在两次检查之间退出，ps 的非零状态就是退出确认结果。
          return false;
        }
        if (state.startsWith('Z')) return false;
      }
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  const wait = async (timeout) => {
    const until = Date.now() + timeout;
    while (ids.some(alive)) {
      if (Date.now() >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  };
  for (const pid of ids) signal(pid, 'SIGTERM');
  if (await wait(1500)) return;
  // macOS 的进程可以处理 SIGTERM；保存时限后强制退出，并确认退出后才继续同步。
  for (const pid of [...ids].reverse()) if (alive(pid)) signal(pid, 'SIGKILL');
  if (!(await wait(1000))) throw Error('旧 Codex 进程尚未退出，未继续同步对话或重载客户端。');
}

module.exports = { stopProcesses };
