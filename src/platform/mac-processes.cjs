'use strict';
const { PROJECT_ROOT } = require('../paths.cjs');

const cp = require('node:child_process'),
  fs = require('node:fs'),
  path = require('node:path');
const helper = path.join(PROJECT_ROOT, 'bin', 'mac-process-context'),
  psArgs = ['-axo', 'pid=,ppid=,etime=,comm='],
  psOptions = { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  helperOptions = { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] };

function parseProcesses(output) {
  return output.split('\n').flatMap((line) => {
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
}
function codexProcesses(ancestry) {
  return ancestry.filter(
    (p) =>
      /^codex(?:-(?:aarch64|x86_64).*)?$/.test(p.name) ||
      require('./platform.cjs').isCodexDesktop(p.exe),
  );
}
function described(p, context) {
  const [dayPart, timePart] = p.elapsed.includes('-') ? p.elapsed.split('-') : ['0', p.elapsed];
  let seconds = 0;
  for (const n of timePart.split(':').map(Number)) seconds = seconds * 60 + n;
  seconds += Number(dayPart) * 86400;
  return { ...p, context, startedAt: new Date(Date.now() - seconds * 1000).toISOString() };
}
const helperError = (error) => ({
  ok: false,
  error: error.code === 'EACCES' ? 'process_helper_not_executable' : 'process_helper_failed',
});
function scan() {
  // 同步调用方保留原入口；网页与心跳通过下面的异步入口扫描。
  const ancestry = parseProcesses(cp.execFileSync('/bin/ps', psArgs, psOptions));
  const processes = codexProcesses(ancestry).map((p) => {
    let context = { ok: false, error: 'process_context_helper_missing' };
    if (fs.existsSync(helper)) {
      try {
        context = JSON.parse(cp.execFileSync(helper, [String(p.pid)], helperOptions));
      } catch (error) {
        context = helperError(error);
      }
    }
    return described(p, context);
  });
  return { ancestry, processes };
}
async function scanAsync() {
  const run = (file, args, options) =>
    new Promise((resolve, reject) => {
      cp.execFile(file, args, options, (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      );
    });
  const ancestry = parseProcesses(await run('/bin/ps', psArgs, psOptions)),
    helperExists = fs.existsSync(helper);
  // 各个 Codex 进程互不依赖，原生读取并行运行，等待期间让出事件循环。
  const processes = await Promise.all(
    codexProcesses(ancestry).map(async (p) => {
      let context = { ok: false, error: 'process_context_helper_missing' };
      if (helperExists) {
        try {
          context = JSON.parse(await run(helper, [String(p.pid)], helperOptions));
        } catch (error) {
          context = helperError(error);
        }
      }
      return described(p, context);
    }),
  );
  return { ancestry, processes };
}
module.exports = { scan, scanAsync };
