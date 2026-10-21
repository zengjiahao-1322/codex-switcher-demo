const { PROJECT_ROOT } = require('../paths.cjs');
// Codex API 切换器：本机网页界面 + 本机转换服务（127.0.0.1:47831）。核心逻辑在 service.cjs，与 Codex 内的 MCP 工具共用。
const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  cp = require('child_process'),
  crypto = require('crypto');
const { createServer } = require('./server.cjs'),
  { createService } = require('./service.cjs');
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
function ownsOldService(pid, entry) {
  let command;
  if (process.platform === 'darwin') {
    command = cp.execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    });
    if (!/(?:^|\/)node(?:\s|"|$)/.test(command)) return false;
  } else {
    const found = JSON.parse(
      require('../clients/desktop-account.cjs').powershell(
        '$p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$env:SWITCHER_UPDATE_PID);if($p){@{exe=$p.ExecutablePath;command=$p.CommandLine}|ConvertTo-Json -Compress}else{"null"}',
        { SWITCHER_UPDATE_PID: String(pid) },
      ),
    );
    if (!found || path.basename(found.exe).toLowerCase() !== 'node.exe') return false;
    command = found.command;
  }
  // macOS 的 ps 可能把 /private、符号链接或临时目录显示成另一种等价路径；
  // 已确认 Node 可执行文件后，按主入口文件名核对，避免合法旧后台被误拒绝。
  const main = entry ? path.basename(entry) : 'main.cjs';
  return command.includes(main) && /(?:^|[\\/])main\.cjs(?:\s|"|$)/.test(command);
}
// 只复用相同构建；更新应用不能继续打开仍在内存中的旧后台和旧页面。
async function existing() {
  const r = readJson(runningPath);
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
  if (oldRuntime?.id === runtimeInfo.id && oldRuntime.pid === r.pid) return r;
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
  await require('../platform/process-stop.cjs').stopProcesses([r.pid]);
  return null;
}
(async () => {
  const prior = await existing();
  if (prior) {
    console.log('BRIDGE_ALREADY_RUNNING ' + new URL(prior.url).origin);
    openUrl(prior.url);
    return;
  }
  const discoveryDir =
    !process.env.BRIDGE_HOME || process.env.BRIDGE_DISCOVERY_DIR
      ? process.env.BRIDGE_DISCOVERY_DIR || path.join(os.homedir(), '.codex-api-switcher')
      : null;
  const dataDirProtection = require('../platform/data-protection.cjs').protectDataDirs(
    [bridgeHome, discoveryDir].filter(Boolean),
  );
  const svc = createService({
    codexHome,
    bridgeHome,
    hermesHome,
    projectDir: PROJECT_ROOT,
    defaultPort: Number(process.env.BRIDGE_PORT) || 47831,
    dataDirProtection,
  });
  const token = crypto.randomBytes(32).toString('hex'),
    a = svc.adapterSettings();
  const server = createServer({
    runtime: runtimeInfo,
    token,
    getState: svc.state,
    actions: svc.actions,
    adapterToken: a.token,
    handleResponses: (req, res) => svc.handleResponses(req, res, { onError: logAdapter }),
  });
  const ready = () => {
    const port = server.address().port;
    svc.setListeningPort(port);
    const url = 'http://127.0.0.1:' + port + '/#' + token;
    const connection = { pid: process.pid, url, build: runtimeInfo };
    writeJson(runningPath, connection);
    if (!process.env.BRIDGE_HOME || process.env.BRIDGE_DISCOVERY_DIR) {
      const dir =
        process.env.BRIDGE_DISCOVERY_DIR || path.join(os.homedir(), '.codex-api-switcher');
      fs.mkdirSync(dir, { recursive: true });
      writeJson(path.join(dir, 'connection.json'), connection);
    }
    console.log('BRIDGE_READY http://127.0.0.1:' + port);
    openUrl(url);
  };
  // 固定端口被其他程序占用时退回随机端口：界面仍可用，但转换模式不可用。
  server.once('error', async (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    const prior = await existing();
    if (prior) {
      console.log('BRIDGE_ALREADY_RUNNING ' + new URL(prior.url).origin);
      openUrl(prior.url);
      return;
    }
    console.log('BRIDGE_PORT_IN_USE ' + a.port);
    server.listen(0, '127.0.0.1');
  });
  // 端口回落时仍只执行一次 ready，避免重复打开页面及覆盖正在读取的连接记录。
  server.once('listening', ready);
  server.listen(a.port, '127.0.0.1');
  const cleanup = () => {
    const r = readJson(runningPath);
    if (r?.pid === process.pid) fs.rmSync(runningPath, { force: true });
  };
  process.on('exit', cleanup);
  for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(s, () => process.exit(0));
})();
