'use strict';
const cp = require('node:child_process'),
  fs = require('node:fs'),
  path = require('node:path');
function scan() {
  // ps 负责枚举父子关系；原生助手单独读取 Codex 进程的配置归属，避免输出整个环境。
  const output = cp.execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,etime=,comm='], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const ancestry = output.split('\n').flatMap((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d:-]+)\s+(.+)$/);
    return m
      ? [
          {
            pid: Number(m[1]),
            parentPid: Number(m[2]),
            elapsed: m[3],
            exe: m[4],
            name: path.basename(m[4]),
          },
        ]
      : [];
  });
  const helper = path.join(__dirname, 'bin', 'mac-process-context');
  const processes = ancestry
    .filter(
      (p) =>
        /^codex(?:-(?:aarch64|x86_64).*)?$/.test(p.name) ||
        require('./platform.cjs').isCodexDesktop(p.exe),
    )
    .map((p) => {
      let context = { ok: false, error: 'process_context_helper_missing' };
      if (fs.existsSync(helper)) {
        try {
          context = JSON.parse(
            cp.execFileSync(helper, [String(p.pid)], {
              encoding: 'utf8',
              timeout: 3000,
              stdio: ['ignore', 'pipe', 'ignore'],
            }),
          );
        } catch (e) {
          context = {
            ok: false,
            error: e.code === 'EACCES' ? 'process_helper_not_executable' : 'process_helper_failed',
          };
        }
      }
      const [dayPart, timePart] = p.elapsed.includes('-') ? p.elapsed.split('-') : ['0', p.elapsed];
      const segments = timePart.split(':').map(Number);
      let seconds = 0;
      for (const n of segments) seconds = seconds * 60 + n;
      seconds += Number(dayPart) * 86400;
      return { ...p, context, startedAt: new Date(Date.now() - seconds * 1000).toISOString() };
    });
  return { ancestry, processes };
}
module.exports = { scan };
