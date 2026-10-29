'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process');
const { log } = require('../src/diagnostics/event-log.cjs');
const { validatePackage } = require('../src/server/update.cjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
async function waitForExit(pid, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() >= deadline) throw Error('旧切换器后台未退出，安装文件尚未替换。');
    await sleep(100);
  }
}
async function launch(target, job) {
  const node =
    job.platform === 'win32'
      ? path.join(target, 'runtime', 'node.exe')
      : path.join(target, 'runtime', job.arch, 'node');
  const child = cp.spawn(node, [path.join(target, 'main.cjs')], {
    cwd: target,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      BRIDGE_HOME: job.bridgeHome,
      BRIDGE_CODEX_HOME: job.codexHome,
      BRIDGE_DISCOVERY_DIR: job.discoveryDir || '',
    },
  });
  await require('node:events').once(child, 'spawn');
  child.unref();
  return child.pid;
}
async function healthy(job, timeoutMs = 30000) {
  const data =
    job.platform === 'win32' &&
    path.resolve(job.bridgeHome).toLowerCase() === path.resolve(job.target, 'private').toLowerCase()
      ? path.join(process.env.LOCALAPPDATA, 'CodexSwitcher')
      : job.bridgeHome;
  const deadline = Date.now() + timeoutMs,
    runningFile = path.join(data, 'running.json');
  let detail = '未收到新后台的运行记录';
  while (Date.now() < deadline) {
    if (fs.existsSync(runningFile)) {
      const running = JSON.parse(fs.readFileSync(runningFile, 'utf8'));
      if (running.build?.id === job.build) {
        try {
          const url = new URL(running.url),
            response = await fetch(url.origin + '/api/runtime', {
              headers: { Authorization: 'Bearer ' + url.hash.slice(1) },
              signal: AbortSignal.timeout(1000),
            });
          if (response.ok && (await response.json()).id === job.build) return;
          detail = '新后台构建号未通过检查';
        } catch (error) {
          detail = error.message;
        }
      }
    }
    await sleep(100);
  }
  throw Error('新后台在30秒内未通过健康检查：' + detail);
}
async function stop(pid) {
  try {
    process.kill(pid);
  } catch (error) {
    if (error.code === 'ESRCH') return;
    throw error;
  }
  await waitForExit(pid, 3000);
}
function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, fs.statSync(source).mode & 0o777);
}
function windowsReplacement(job, previous) {
  const files = validatePackage(job.source);
  const oldFiles = JSON.parse(fs.readFileSync(path.join(job.target, 'release-files.json'), 'utf8'));
  const touched = [...new Set([...oldFiles, ...files])];
  for (const relative of touched) {
    if (
      path.isAbsolute(relative) ||
      relative.split(/[\\/]/).includes('..') ||
      /^(?:private|\.git)(?:[\\/]|$)/i.test(relative)
    )
      throw Error('旧发行清单包含无效文件路径。');
    const source = path.join(job.target, relative);
    if (fs.existsSync(source)) copyFile(source, path.join(previous, relative));
  }
  const dirs = ['runtime', 'bin', 'node_modules'];
  for (const dir of dirs)
    fs.cpSync(path.join(job.target, dir), path.join(previous, dir), {
      recursive: true,
      preserveTimestamps: true,
    });
  const restore = () => {
    for (const relative of touched) {
      const old = path.join(previous, relative),
        target = path.join(job.target, relative);
      if (fs.existsSync(old)) copyFile(old, target);
      else fs.rmSync(target, { force: true });
    }
    for (const dir of dirs) {
      fs.rmSync(path.join(job.target, dir), { recursive: true, force: true });
      fs.cpSync(path.join(previous, dir), path.join(job.target, dir), {
        recursive: true,
        preserveTimestamps: true,
      });
    }
  };
  return {
    apply: () => {
      for (const relative of touched)
        if (!files.includes(relative)) fs.rmSync(path.join(job.target, relative), { force: true });
      for (const relative of files)
        copyFile(path.join(job.source, relative), path.join(job.target, relative));
      for (const dir of dirs) {
        fs.rmSync(path.join(job.target, dir), { recursive: true, force: true });
        fs.cpSync(path.join(job.source, dir), path.join(job.target, dir), {
          recursive: true,
          preserveTimestamps: true,
        });
      }
    },
    restore,
  };
}
function macReplacement(job, previous) {
  const app = path.resolve(job.target, '..', '..'),
    sourceApp = path.resolve(job.source, '..', '..');
  if (!app.endsWith('.app') || app.includes('/AppTranslocation/'))
    throw Error('当前应用位置不允许直接升级。');
  const old = path.join(previous, 'Codex Switcher.app'),
    incoming = app + '.update',
    outgoing = app + '.previous';
  cp.execFileSync('/usr/bin/ditto', [app, old]);
  fs.rmSync(incoming, { recursive: true, force: true });
  fs.rmSync(outgoing, { recursive: true, force: true });
  cp.execFileSync('/usr/bin/ditto', [sourceApp, incoming]);
  return {
    apply: () => {
      fs.renameSync(app, outgoing);
      fs.renameSync(incoming, app);
    },
    restore: () => {
      fs.rmSync(app, { recursive: true, force: true });
      if (fs.existsSync(outgoing)) fs.renameSync(outgoing, app);
      else cp.execFileSync('/usr/bin/ditto', [old, app]);
    },
    complete: () => fs.rmSync(outgoing, { recursive: true, force: true }),
  };
}
async function performUpdate(
  job,
  { wait = waitForExit, launchApp = launch, checkHealth = healthy, stopApp = stop } = {},
) {
  const started = performance.now(),
    previous = path.join(job.bridgeHome, 'updates', 'previous'),
    result = path.join(job.bridgeHome, 'updates', 'result.json');
  await wait(job.pid);
  let replacement, newPid;
  try {
    fs.rmSync(previous, { recursive: true, force: true });
    fs.mkdirSync(previous, { recursive: true });
    replacement =
      job.platform === 'win32' ? windowsReplacement(job, previous) : macReplacement(job, previous);
    log(job.bridgeHome, 'update.install', { build: job.build, status: 'started', durationMs: 0 });
    replacement.apply();
    fs.writeFileSync(result, JSON.stringify({ build: job.build }));
    newPid = await launchApp(job.target, job);
    await checkHealth(job);
    replacement.complete?.();
    log(job.bridgeHome, 'update.install', {
      build: job.build,
      status: 'done',
      durationMs: Math.round(performance.now() - started),
    });
  } catch (error) {
    log(job.bridgeHome, 'update.install', {
      build: job.build,
      error: error.message,
      durationMs: Math.round(performance.now() - started),
    });
    try {
      if (newPid) await stopApp(newPid);
      if (replacement) replacement.restore();
      const message =
        (replacement ? '更新失败，已恢复上一版：' : '更新未完成，原版本未改动：') + error.message;
      fs.writeFileSync(result, JSON.stringify({ build: job.build, error: message }));
      await launchApp(job.target, job);
      log(job.bridgeHome, 'update.rollback', {
        build: job.build,
        status: 'done',
        error: message,
        durationMs: Math.round(performance.now() - started),
      });
    } catch (rollbackError) {
      throw Error('更新失败：' + error.message + '；恢复未完成：' + rollbackError.message);
    }
  }
}
if (require.main === module) {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (process.send) {
    process.send({ ready: true });
    process.disconnect();
  }
  performUpdate(job).catch((error) => {
    const message = '升级未完成：' + error.message;
    fs.writeFileSync(
      path.join(job.bridgeHome, 'updates', 'result.json'),
      JSON.stringify({ error: message, build: job.build }),
    );
    log(job.bridgeHome, 'update.rollback', { build: job.build, error: message, status: 'error' });
    process.exitCode = 1;
  });
}
module.exports = { performUpdate, healthy, waitForExit, windowsReplacement, macReplacement };
