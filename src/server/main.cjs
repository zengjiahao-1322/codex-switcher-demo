const { PROJECT_ROOT } = require('../paths.cjs');
// Codex API 切换器：本机网页界面 + 本机转换服务（127.0.0.1:47831）。核心逻辑在 service.cjs，与 Codex 内的 MCP 工具共用。
const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  cp = require('child_process'),
  crypto = require('crypto');
const { createServer } = require('./server.cjs'),
  { createService } = require('./service.cjs');
const { log: logEvent } = require('../diagnostics/event-log.cjs');
const { writeJson } = require('../accounts/accounts.cjs');
const platform = require('../platform/platform.cjs'),
  codexHome = platform.codexHome(),
  bridgeHome = platform.dataHome();
// Hermes 只作为首次导入来源；不存在也不影响使用。
const hermesHome =
  process.env.BRIDGE_HERMES_HOME ||
  path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'Hermes Agent CN Desktop',
    'data',
    'hermes-home',
  );
fs.mkdirSync(bridgeHome, { recursive: true });
const runningPath = path.join(bridgeHome, 'running.json'),
  noOpen = process.argv.includes('--no-open');
const discoveryDir =
  !process.env.BRIDGE_HOME || process.env.BRIDGE_DISCOVERY_DIR
    ? process.env.BRIDGE_DISCOVERY_DIR || path.join(os.homedir(), '.codex-api-switcher')
    : null;
let otherInstall = null;
const runtimeInfo = {
  ...require('../platform/build-info.cjs').buildInfo(),
  pid: process.pid,
  entry: path.join(PROJECT_ROOT, 'main.cjs'),
};
const openUrl = (url) => {
  if (!noOpen) platform.openUrl(url);
};
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
function fatal(e) {
  try {
    fs.appendFileSync(
      path.join(bridgeHome, 'main-error.log'),
      new Date().toISOString() + ' ' + String(e?.stack || e).slice(0, 2000) + '\n',
    );
  } catch {}
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
function logAdapter(message) {
  try {
    const p = path.join(bridgeHome, 'adapter.log');
    if (fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024) fs.renameSync(p, p + '.1');
    fs.appendFileSync(p, new Date().toISOString() + ' ' + message + '\n', { mode: 0o600 });
  } catch {}
}
function nodeCommand(pid) {
  let command;
  if (process.platform === 'darwin') {
    command = cp.execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    });
    if (!/(?:^|\/)node(?:\s|"|$)/.test(command)) return null;
  } else {
    const found = JSON.parse(
      require('../clients/desktop-account.cjs').powershell(
        '$p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$env:SWITCHER_UPDATE_PID);if($p){@{exe=$p.ExecutablePath;command=$p.CommandLine}|ConvertTo-Json -Compress}else{"null"}',
        { SWITCHER_UPDATE_PID: String(pid) },
      ),
    );
    if (!found || !found.exe || path.basename(found.exe).toLowerCase() !== 'node.exe') return null;
    command = found.command;
  }
  return command;
}
function ownsOldService(pid, entry) {
  const command = nodeCommand(pid),
    main = entry ? path.basename(entry) : 'main.cjs';
  // 升级接管已先验证服务鉴权；允许新副本替换旧目录及没有 runtime 接口的旧版本。
  return !!command && command.includes(main) && /(?:^|[\\/])main\.cjs(?:\s|"|$)/.test(command);
}
function sameInstall(pid) {
  const command = nodeCommand(pid);
  if (!command) return false;
  // ps 不保留 argv 的引号；从 Node 后面提取完整入口，保留应用目录中的空格。
  const actual = command.match(
    /(?:^|[\\/])node(?:\.exe)?"?\s+"?(.+?[\\/]main\.cjs)"?(?:\s|$)/i,
  )?.[1];
  if (!actual) return false;
  try {
    const actualEntry = fs.realpathSync.native(actual),
      expectedEntry = fs.realpathSync.native(runtimeInfo.entry);
    return process.platform === 'win32'
      ? actualEntry.toLowerCase() === expectedEntry.toLowerCase()
      : actualEntry === expectedEntry;
  } catch (error) {
    // 旧副本已移动或删除时不能证明同一安装，让新服务使用空闲端口。
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}
function listeningPid(port) {
  if (process.platform === 'darwin') {
    let output;
    try {
      output = cp
        .execFileSync('/usr/sbin/lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-t'], {
          encoding: 'utf8',
        })
        .trim();
    } catch (error) {
      if (error.status === 1) return null;
      throw error;
    }
    return Number(output.split(/\s+/)[0]) || null;
  }
  const output = cp.execFileSync('netstat.exe', ['-ano', '-p', 'TCP'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const match = output.match(
    new RegExp(
      '^\\s*TCP\\s+127\\.0\\.0\\.1:' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$',
      'mi',
    ),
  );
  return match ? Number(match[1]) : null;
}
async function waitPortFree(port) {
  const deadline = Date.now() + 1000;
  while (listeningPid(port)) {
    if (Date.now() >= deadline) throw Error('旧切换器已退出但固定端口仍被占用。');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function reclaimFixedPort(port) {
  const pid = listeningPid(port);
  if (!pid || !sameInstall(pid)) return false;
  await require('../platform/process-stop.cjs').stopProcesses([pid]);
  await waitPortFree(port);
  return true;
}
// 只复用相同构建；更新应用不能继续打开仍在内存中的旧后台和旧页面。
async function existing() {
  const local = readJson(runningPath),
    discovered =
      !local && discoveryDir ? readJson(path.join(discoveryDir, 'connection.json')) : null,
    r = local || discovered,
    fromDiscovery = !!discovered;
  if (!r) return null;
  try {
    process.kill(r.pid, 0);
  } catch {
    return null;
  }
  const u = new URL(r.url);
  try {
    const res = await fetch(u.origin + '/', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
  } catch {
    return null;
  }
  const headers = { Authorization: 'Bearer ' + u.hash.slice(1) };
  const response = await fetch(u.origin + '/api/runtime', {
    headers,
    signal: AbortSignal.timeout(3000),
  });
  const oldRuntime = response.ok ? await response.json() : null;
  if (oldRuntime?.id === runtimeInfo.id && oldRuntime.pid === r.pid) {
    const oldSequence = Number(r.build?.sequence || oldRuntime.sequence || 0),
      currentSequence = Number(runtimeInfo.sequence || 0);
    if (fromDiscovery && oldSequence >= currentSequence) {
      otherInstall = { pid: r.pid, sequence: oldSequence, action: 'deferred' };
      return r;
    }
    if (fromDiscovery && oldSequence < currentSequence) {
      otherInstall = { pid: r.pid, sequence: oldSequence, action: 'stopped' };
      await require('../platform/process-stop.cjs').stopProcesses([r.pid]);
      return null;
    }
    return r;
  }
  // 旧版没有构建接口，用既有鉴权接口确认服务，再核对 PID 确实属于 Node 主入口。
  let verified = oldRuntime?.pid === r.pid;
  if (!oldRuntime) {
    const legacy = await fetch(u.origin + '/api/accounts', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    });
    const accountState = legacy.ok ? await legacy.json() : null;
    verified = Array.isArray(accountState?.items) && Object.hasOwn(accountState, 'switchJob');
  }
  if (!verified || !ownsOldService(r.pid, oldRuntime?.entry))
    throw Error('无法确认旧切换器后台归属，请先关闭旧切换器再启动新版；配置尚未修改。');
  // 更新包接管旧后台时也使用统一的退出策略：先给服务清理机会，
  // 但不能因为旧进程卡住而让新版本永远打不开。
  if (fromDiscovery) {
    const oldSequence = Number(r.build?.sequence || oldRuntime?.sequence || 0),
      currentSequence = Number(runtimeInfo.sequence || 0),
      action = require('../platform/app-lifecycle.cjs').otherInstallAction(
        oldSequence,
        currentSequence,
      );
    otherInstall = { pid: r.pid, sequence: oldSequence, action };
    if (action === 'deferred') return r;
  }
  await require('../platform/process-stop.cjs').stopProcesses([r.pid]);
  return null;
}
(async () => {
  const hadRunning = !!readJson(runningPath);
  let phaseStarted = performance.now();
  const prior = await existing();
  const phases = { existing: Math.round(performance.now() - phaseStarted) };
  if (prior) {
    if (discoveryDir) {
      writeJson(path.join(discoveryDir, 'connection.json'), prior);
    }
    console.log('BRIDGE_ALREADY_RUNNING ' + new URL(prior.url).origin);
    logEvent(bridgeHome, 'startup', { otherInstall });
    openUrl(prior.url);
    return;
  }
  const desktopMarker = discoveryDir && readJson(path.join(discoveryDir, 'shortcut.json'));
  const desktopIntegrationNeeded =
    process.platform === 'win32' &&
    Number.isSafeInteger(runtimeInfo.sequence) &&
    !(desktopMarker?.created && Number(desktopMarker.sequence) >= runtimeInfo.sequence);
  const protectedDirs = [bridgeHome, discoveryDir].filter(Boolean),
    protectSkipped =
      protectedDirs.length > 0 &&
      protectedDirs.every(
        (dir) => readJson(path.join(dir, 'acl-protected.json'))?.path === path.resolve(dir),
      );
  phaseStarted = performance.now();
  const dataDirProtection = require('../platform/data-protection.cjs').protectDataDirs(
    protectedDirs,
  );
  phases.protectDataDirs = Math.round(performance.now() - phaseStarted);
  phaseStarted = performance.now();
  const svc = createService({
    codexHome,
    bridgeHome,
    hermesHome,
    projectDir: PROJECT_ROOT,
    defaultPort: Number(process.env.BRIDGE_PORT) || 47831,
    dataDirProtection,
    discoveryDir,
    shutdownForUpdate: () => {
      server.close();
      server.closeAllConnections();
      process.exit(0);
    },
  });
  phases.createService = Math.round(performance.now() - phaseStarted);
  const token = crypto.randomBytes(32).toString('hex'),
    a = svc.adapterSettings();
  const server = createServer({
    runtime: runtimeInfo,
    token,
    getState: svc.state,
    actions: svc.actions,
    adapterToken: a.token,
    handleResponses: (req, res) => svc.handleResponses(req, res, { onError: logAdapter }),
    onFirstApiRequest: (route) =>
      logEvent(bridgeHome, 'startup.firstRequest', {
        sinceReadyMs: Math.round(performance.now() - readyAt),
        route,
      }),
  });
  let readyAt;
  const ready = () => {
    phases.listen = Math.round(performance.now() - phaseStarted);
    readyAt = performance.now();
    const port = server.address().port;
    svc.setListeningPort(port);
    const url = 'http://127.0.0.1:' + port + '/#' + token;
    const connection = { pid: process.pid, url, build: runtimeInfo };
    writeJson(runningPath, connection);
    if (discoveryDir) writeJson(path.join(discoveryDir, 'connection.json'), connection);
    logEvent(bridgeHome, 'startup', {
      readyMs: Math.round(process.uptime() * 1000),
      phases,
      port,
      handover: hadRunning && !prior,
      protectSkipped,
      ...(handoverResult || {}),
      ...(otherInstall ? { otherInstall } : {}),
    });
    if (desktopIntegrationNeeded)
      setImmediate(() => {
        try {
          require('../platform/app-lifecycle.cjs').integrateDesktop(
            PROJECT_ROOT,
            discoveryDir,
            bridgeHome,
          );
        } catch (error) {
          logEvent(bridgeHome, 'app.shortcuts', { status: 'error', error: error.message });
        }
      });
    console.log('BRIDGE_READY http://127.0.0.1:' + port);
    openUrl(url);
  };
  let handoverResult = null;
  const handleListenError = async (e) => {
    if (!['EADDRINUSE', 'EACCES'].includes(e.code)) throw e;
    const ownerPid = e.code === 'EADDRINUSE' ? listeningPid(a.port) : null;
    if (e.code === 'EADDRINUSE' && (await reclaimFixedPort(a.port))) {
      handoverResult = { reclaimed: { pid: ownerPid } };
      console.log('BRIDGE_RECLAIMED_OLD_SERVICE ' + a.port);
      server.once('error', handleListenError);
      server.listen(a.port, '127.0.0.1');
      return;
    }
    // 固定端口被其他程序占用时退回随机端口：界面仍可用，但转换模式不可用。
    handoverResult = {
      portFallback: {
        port: a.port,
        ownerPid: ownerPid || null,
        reason: e.code === 'EACCES' ? 'EACCES' : ownerPid ? 'different_process' : 'port_in_use',
      },
    };
    if (e.code === 'EADDRINUSE') {
      const prior = await existing();
      if (prior) {
        if (discoveryDir) writeJson(path.join(discoveryDir, 'connection.json'), prior);
        console.log('BRIDGE_ALREADY_RUNNING ' + new URL(prior.url).origin);
        openUrl(prior.url);
        return;
      }
    }
    console.log(
      (e.code === 'EACCES' ? 'BRIDGE_PORT_PERMISSION_DENIED ' : 'BRIDGE_PORT_IN_USE ') + a.port,
    );
    server.listen(0, '127.0.0.1');
  };
  server.once('error', handleListenError);
  // 端口回落时仍只执行一次 ready，避免重复打开页面及覆盖正在读取的连接记录。
  server.once('listening', ready);
  phaseStarted = performance.now();
  server.listen(a.port, '127.0.0.1');
  const cleanup = () => {
    const r = readJson(runningPath);
    if (r?.pid === process.pid) fs.rmSync(runningPath, { force: true });
  };
  process.on('exit', cleanup);
  for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(s, () => process.exit(0));
})();
