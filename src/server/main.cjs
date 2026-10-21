const { PROJECT_ROOT } = require('../paths.cjs');
// Codex API 切换器：本机网页界面 + 本机转换服务（127.0.0.1:47831）。核心逻辑在 service.cjs，与 Codex 内的 MCP 工具共用。
const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  cp = require('child_process'),
  crypto = require('crypto');
const { createServer } = require('./server.cjs'),
  { createService } = require('./service.cjs');
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
// 单实例：已有服务仍在响应时直接打开它，不再启动新服务。
async function existing() {
  const r = readJson(runningPath);
  if (!r) return null;
  try {
    process.kill(r.pid, 0);
  } catch {
    return null;
  }
  try {
    const u = new URL(r.url);
    const res = await fetch(u.origin + '/', { signal: AbortSignal.timeout(3000) });
    return res.ok ? r : null;
  } catch {
    return null;
  }
}
(async () => {
  const prior = await existing();
  if (prior) {
    console.log('BRIDGE_ALREADY_RUNNING ' + new URL(prior.url).origin);
    openUrl(prior.url);
    return;
  }
  const svc = createService({
    codexHome,
    bridgeHome,
    hermesHome,
    projectDir: PROJECT_ROOT,
    defaultPort: Number(process.env.BRIDGE_PORT) || 47831,
  });
  const token = crypto.randomBytes(32).toString('hex'),
    a = svc.adapterSettings();
  const server = createServer({
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
    const connection = { pid: process.pid, url };
    fs.writeFileSync(runningPath, JSON.stringify(connection), { mode: 0o600 });
    if (!process.env.BRIDGE_HOME || process.env.BRIDGE_DISCOVERY_DIR) {
      const dir =
        process.env.BRIDGE_DISCOVERY_DIR || path.join(os.homedir(), '.codex-api-switcher');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'connection.json'), JSON.stringify(connection), {
        mode: 0o600,
      });
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
    server.listen(0, '127.0.0.1', ready);
  });
  server.listen(a.port, '127.0.0.1', ready);
  const cleanup = () => {
    const r = readJson(runningPath);
    if (r?.pid === process.pid) fs.rmSync(runningPath, { force: true });
  };
  process.on('exit', cleanup);
  for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(s, () => process.exit(0));
})();
