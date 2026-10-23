// 第二阶段验收（规格见 COLLAB.md“伴随扩展改为长轮询”）：服务器挂起与唤醒、旧版兼容、伴随扩展的请求节奏。
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  http = require('node:http'),
  Module = require('node:module');

const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const serverReady = source('src/server/service.cjs').includes('longPoll');
const companionReady = source('vscode-companion/extension.cjs').includes('longPoll');
const server = { todo: !serverReady && '等待 GPT 实现 L1/L2' };
const companion = { todo: !companionReady && '等待 GPT 实现 L3' };

// 真实 HTTP 服务 + 真实 service，数据目录隔离。
async function start() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-longpoll-'));
  const codexHome = path.join(root, 'codex'),
    bridgeHome = path.join(root, 'bridge');
  fs.mkdirSync(codexHome);
  fs.mkdirSync(bridgeHome);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model="gpt-5"\n');
  const { createService } = require('../src/server/service.cjs');
  const { createServer } = require('../src/server/server.cjs');
  const service = createService({ codexHome, bridgeHome });
  const s = createServer({ token: 'lp-token', getState: service.state, actions: service.actions });
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + s.address().port;
  const beat = async (body, signal) => {
    const t = performance.now();
    const r = await fetch(base + '/api/clientHeartbeat', {
      method: 'POST',
      headers: { Authorization: 'Bearer lp-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: process.pid, name: 'VS Code', reloadProtocol: 3, ...body }),
      signal,
    });
    return { ms: performance.now() - t, body: await r.json() };
  };
  return { bridgeHome, beat, close: () => new Promise((r) => s.close(r)) };
}

test('不带 wait 的心跳立即返回（兼容旧版伴随扩展）', async () => {
  const s = await start();
  try {
    const r = await s.beat({ id: 'window-old-0001' });
    assert.ok(r.ms < 1500, '耗时 ' + Math.round(r.ms) + ' ms');
    assert.ok(r.body.connection);
  } finally {
    await s.close();
  }
});

test(
  '带 wait 且没有命令时挂起约 10 秒，回复声明 longPoll；挂起期间记录仍有效',
  server,
  async () => {
    const s = await start();
    try {
      await s.beat({ id: 'window-hold-0001' });
      const pending = s.beat({ id: 'window-hold-0001', wait: 10000 });
      await new Promise((r) => setTimeout(r, 9000));
      const { records } = require('../src/clients/client-status.cjs');
      assert.ok(
        records(s.bridgeHome).some((c) => c.id === 'window-hold-0001'),
        '挂起期间切换进程应能读到这个窗口',
      );
      const r = await pending;
      assert.ok(r.ms >= 9500 && r.ms <= 11000, '挂起 ' + Math.round(r.ms) + ' ms');
      assert.equal(r.body.longPoll, true);
      assert.equal(r.body.command, null);
    } finally {
      await s.close();
    }
  },
);

test('挂起期间另一进程写入重载命令，500 ms 内返回命令', server, async () => {
  const s = await start();
  try {
    await s.beat({ id: 'window-cmd-0001' });
    const pending = s.beat({ id: 'window-cmd-0001', wait: 10000 });
    await new Promise((r) => setTimeout(r, 1000));
    // 模拟切换后台进程：直接改写窗口记录文件，写入待取命令。
    const file = path.join(s.bridgeHome, 'clients', 'window-cmd-0001.json');
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    const written = performance.now();
    require('../src/accounts/accounts.cjs').writeJson(file, {
      ...row,
      command: { id: 'cmd-0001', type: 'reload' },
    });
    const r = await pending;
    assert.equal(r.body.command?.id, 'cmd-0001');
    assert.ok(performance.now() - written < 500, '取命令延迟过长');
  } finally {
    await s.close();
  }
});

// 新窗口的伴随扩展通常先于官方后端启动：挂起期间后端接入时，这次回复就应反映结束时的状态。
test('挂起结束时按缓存期限重新确认连接，回复反映结束时的状态', server, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-longpoll-state-'));
  const codexHome = path.join(root, 'codex'),
    bridgeHome = path.join(root, 'bridge');
  fs.mkdirSync(codexHome);
  fs.mkdirSync(bridgeHome);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model="gpt-5"\n');
  const clients = require('../src/clients/client-status.cjs');
  let backendReady = false;
  t.mock.method(clients, 'scanAsync', async () => ({ ancestry: [], processes: [] }));
  t.mock.method(clients, 'snapshot', () => ({
    clients: backendReady
      ? [{ kind: 'ide', editorId: 'window-late-0001', confirmed: true, shared: true, pid: 777 }]
      : [],
  }));
  const service = require('../src/server/service.cjs').createService({ codexHome, bridgeHome });
  const beat = (extra) =>
    service.actions.clientHeartbeat({
      id: 'window-late-0001',
      pid: 4242,
      name: 'VS Code',
      reloadProtocol: 3,
      ...extra,
    });
  assert.equal((await beat()).connection.state, 'unmatched');
  const held = beat({ wait: 10000 });
  await new Promise((r) => setTimeout(r, 1000));
  backendReady = true;
  const r = await held;
  assert.equal(r.connection.state, 'ready', '挂起期间后端已接入，回复仍是旧状态');
  assert.deepEqual(r.connection.backendPids, [777]);
});

test('客户端中途断开后，服务器不残留定时检查', server, async () => {
  const s = await start();
  try {
    await s.beat({ id: 'window-abort-0001' });
    const timers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
    const baseline = timers();
    const controller = new AbortController();
    const pending = s.beat({ id: 'window-abort-0001', wait: 10000 }, controller.signal);
    await new Promise((r) => setTimeout(r, 600));
    controller.abort();
    await pending.catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    assert.ok(timers() <= baseline, '断开后仍有定时器：' + timers() + ' > ' + baseline);
  } finally {
    await s.close();
  }
});

// 用假的 vscode 模块加载真实的伴随扩展，对着一个可控的假切换器观察请求节奏。
async function runCompanion({
  longPoll,
  failing = false,
  durationMs,
  stateFor = () => 'ready',
  pendingReload,
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-companion-'));
  const requests = [];
  const fake = http.createServer((req, res) => {
    // 模拟切换器不可用：记录这次尝试后直接断开连接。
    if (failing) {
      requests.push({ at: performance.now(), body: {} });
      req.socket.destroy();
      return;
    }
    let text = '';
    req.on('data', (d) => (text += d));
    req.on('end', () => {
      const body = JSON.parse(text || '{}'),
        connectionState = stateFor(requests.length);
      requests.push({ at: performance.now(), body });
      // 模拟挂起：带 wait 的请求延迟 200 ms 再回复。
      setTimeout(
        () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              command: null,
              connection: { state: connectionState, home: '', backendPids: [] },
              ...(longPoll ? { longPoll: true } : {}),
            }),
          );
        },
        body.wait ? 200 : 0,
      );
    });
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const port = fake.address().port;
  const connectionFile = path.join(root, 'connection.json');
  fs.writeFileSync(
    connectionFile,
    JSON.stringify({ url: 'http://127.0.0.1:' + port + '/#companion-token' }),
  );
  const state = new Map(pendingReload ? [['codexSwitcher.pendingReload', pendingReload]] : []);
  const vscode = {
    StatusBarAlignment: { Right: 2 },
    window: { createStatusBarItem: () => ({ show() {}, text: '', tooltip: '' }) },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
    workspace: {
      workspaceFolders: [],
      getConfiguration: (section) => ({
        get: (key, fallback) =>
          section === 'codexSwitcher' && key === 'connectionFile' ? connectionFile : fallback,
      }),
    },
    env: { appName: 'Visual Studio Code', remoteName: undefined },
    extensions: { all: [] },
  };
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : load.call(this, request, ...rest);
  };
  const file = require.resolve('../vscode-companion/extension.cjs');
  delete require.cache[file];
  const subscriptions = [];
  try {
    require(file).activate({
      subscriptions,
      extensionUri: { scheme: 'file' },
      workspaceState: { get: (k) => state.get(k), update: async (k, v) => state.set(k, v) },
    });
  } finally {
    Module._load = load;
  }
  await new Promise((r) => setTimeout(r, durationMs));
  for (const s of subscriptions) s.dispose?.();
  fake.closeAllConnections();
  await new Promise((r) => fake.close(r));
  return requests;
}
const gaps = (requests) => requests.slice(1).map((r, i) => r.at - requests[i].at);

test('服务器支持长轮询时，伴随扩展连续发出带 wait 的请求，不再等 2 秒', companion, async () => {
  const requests = await runCompanion({ longPoll: true, durationMs: 3000 });
  const waiting = requests.filter((r) => r.body.wait === 10000);
  assert.ok(waiting.length >= 5, '3 秒内带 wait 的请求只有 ' + waiting.length + ' 个');
  assert.ok(Math.max(...gaps(waiting)) < 800, '长轮询请求之间出现了长间隔');
  assert.equal(requests[0].body.reloadProtocol, 3);
});

// 重载后新后端尚未接入时，带 completedReload 的请求不挂起且会强制扫描；必须保持约 2 秒一次，接入后再连续长轮询。
test('重载完成待确认期间保持约 2 秒一次，确认接入后才进入连续长轮询', companion, async () => {
  const requests = await runCompanion({
    longPoll: true,
    durationMs: 8000,
    pendingReload: { clientId: 'old-window-0001', commandId: 'cmd-0001' },
    stateFor: (index) => (index < 3 ? 'unmatched' : 'ready'),
  });
  const confirming = requests.filter((r) => r.body.completedReload);
  assert.ok(confirming.length >= 3, '待确认请求只有 ' + confirming.length + ' 个');
  assert.ok(Math.min(...gaps(confirming)) > 1500, '待确认期间请求过密，会造成连续强制扫描');
  const after = requests.slice(requests.indexOf(confirming.at(-1)) + 1);
  assert.ok(after.length >= 3, '确认接入后长轮询请求只有 ' + after.length + ' 个');
  assert.ok(after.every((r) => r.body.wait === 10000 && !r.body.completedReload));
});

test('旧版切换器（回复没有 longPoll）时，伴随扩展仍按约 2 秒一次', companion, async () => {
  const requests = await runCompanion({ longPoll: false, durationMs: 5000 });
  assert.ok(requests.length >= 2 && requests.length <= 4, '5 秒内请求数 ' + requests.length);
  assert.ok(Math.min(...gaps(requests)) > 1500, '旧版服务器下请求过密');
});

test('切换器不可用时，伴随扩展约每 5 秒尝试一次', companion, async () => {
  const attempts = await runCompanion({ longPoll: true, failing: true, durationMs: 11000 });
  // 第 0、5、10 秒左右各一次；原来每 2 秒一次会有 6 次。
  assert.ok(attempts.length >= 2 && attempts.length <= 3, '11 秒内尝试 ' + attempts.length + ' 次');
  assert.ok(Math.min(...gaps(attempts)) > 4000, '失败后重试过密');
});
