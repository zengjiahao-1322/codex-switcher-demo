// 伴随扩展转发远端命令：Remote-SSH 窗口里本机伴随扩展经 VS Code 命令调用服务器端远端代理。
// 用假的 vscode 加载真实伴随扩展，远端命令交给真实远端代理在临时目录里执行。
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  http = require('node:http'),
  crypto = require('node:crypto'),
  Module = require('node:module');
const { createAgent } = require('../vscode-remote-agent/extension.cjs');

const SECRET = 'sk-remote-secret-123';
const original =
  'model = "gpt-5.5"\nmodel_provider = "hermes_bridge"\n\n[model_providers.hermes_bridge]\n' +
  `base_url = "https://api.example.com/v1"\nexperimental_bearer_token = "${SECRET}"\n`;
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

// commandsFor(requests) 返回这次心跳要下发的命令；until(requests) 为真时结束。
async function runCompanion({
  remoteName = 'ssh-remote',
  agentInstalled = true,
  installFails = false,
  commandsFor = () => null,
  confirmFor = () => false,
  pendingReload,
  authText,
  agentVersion,
  until,
}) {
  const statusItem = { show() {}, text: '', tooltip: '' };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-companion-remote-'));
  const home = path.join(root, 'server-codex');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.toml'), original);
  if (authText) fs.writeFileSync(path.join(home, 'auth.json'), authText);
  const agent = createAgent({
    home,
    version: agentVersion ?? require('../vscode-companion/package.json').version,
  });
  const requests = [],
    executed = [],
    installed = [];
  const state = new Map(pendingReload ? [['codexSwitcher.pendingReload', pendingReload]] : []);
  const fake = http.createServer((req, res) => {
    let text = '';
    req.on('data', (d) => (text += d));
    req.on('end', () => {
      const body = JSON.parse(text || '{}');
      requests.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          command: body.ack ? null : commandsFor(requests),
          connection: { state: 'unmatched', home: '', backendPids: [] },
          ...(body.completedReload ? { reloadConfirmed: confirmFor(requests) } : {}),
          longPoll: true,
        }),
      );
    });
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const connectionFile = path.join(root, 'connection.json');
  fs.writeFileSync(
    connectionFile,
    JSON.stringify({ url: 'http://127.0.0.1:' + fake.address().port + '/#companion-token' }),
  );
  const vscode = {
    StatusBarAlignment: { Right: 2 },
    Uri: { file: (fsPath) => ({ scheme: 'file', fsPath }) },
    window: {
      createStatusBarItem: () => statusItem,
      showInformationMessage: async () => undefined,
    },
    commands: {
      registerCommand: () => ({ dispose() {} }),
      executeCommand: async (name, input) => {
        executed.push(name);
        if (name.startsWith('codexSwitcherRemote.')) {
          if (!agentInstalled) throw Error(`command '${name}' not found`);
          return agent[name.split('.')[1]](input);
        }
        if (name === 'workbench.extensions.installExtension') {
          if (installFails) throw Error('install failed');
          installed.push({ path: input.fsPath, bytes: fs.readFileSync(input.fsPath, 'utf8') });
        }
      },
    },
    workspace: {
      workspaceFolders:
        remoteName === 'ssh-remote'
          ? [
              {
                uri: {
                  scheme: 'vscode-remote',
                  authority: 'ssh-remote+gpu-box',
                  fsPath: '/srv/app',
                },
              },
            ]
          : [],
      getConfiguration: (section) => ({
        get: (key, fallback) =>
          section === 'codexSwitcher' && key === 'connectionFile' ? connectionFile : fallback,
      }),
    },
    env: { appName: 'Visual Studio Code', remoteName },
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
  const deadline = Date.now() + 5000;
  while (!until(requests) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  // 等重载的 200 ms 延时执行完。
  await new Promise((r) => setTimeout(r, 300));
  for (const s of subscriptions) s.dispose?.();
  fake.closeAllConnections();
  await new Promise((r) => fake.close(r));
  return { requests, executed, installed, state, home, statusItem };
}
const acked = (id) => (requests) => requests.some((r) => r.ack === id);

test('SSH 窗口心跳附带远端代理状态（约定字段、不含密钥）和 authority', async () => {
  const { requests } = await runCompanion({ until: (r) => r.length >= 1 });
  const first = requests[0];
  assert.equal(first.remoteProtocol, 1);
  assert.equal(first.remoteType, 'ssh-remote');
  assert.equal(first.authority, 'ssh-remote+gpu-box');
  assert.deepEqual(Object.keys(first.remoteAgent).sort(), [
    'account',
    'agentVersion',
    'arch',
    'codexHome',
    'configExists',
    'current',
    'host',
    'platform',
    'protocol',
  ]);
  assert.equal(first.remoteAgent.account, null);
  assert.equal(first.remoteAgent.protocol, 2);
  assert.deepEqual(first.remoteAgent.current, {
    model: 'gpt-5.5',
    modelProvider: 'hermes_bridge',
    baseUrl: 'https://api.example.com/v1',
  });
  assert.equal(JSON.stringify(requests).includes(SECRET), false);
});

// 本机找不到 SSH 窗口的后端是正常的，状态栏按服务器上的远端代理显示，不显示“后端未关联”。
test('SSH 窗口状态栏显示服务器接入情况', async () => {
  const label = async (options) =>
    (await runCompanion({ ...options, until: (r) => r.length >= 2 })).statusItem.text;
  assert.match(await label({}), /服务器已接入$/);
  assert.match(await label({ agentVersion: '0.0.1' }), /远端代理需更新$/);
  assert.match(await label({ agentInstalled: false }), /服务器未装远端代理$/);
});

test('远端代理没装时 remoteAgent 为 null，并把问不到的原因交给后台记日志', async () => {
  const { requests } = await runCompanion({ agentInstalled: false, until: (r) => r.length >= 1 });
  assert.equal(requests[0].remoteAgent, null);
  assert.match(requests[0].remoteAgentError, /codexSwitcherRemote\.status' not found/);
  assert.equal(requests[0].authority, 'ssh-remote+gpu-box');
});

test('本机窗口不调用远端命令，也不上报远端字段', async () => {
  const { requests, executed } = await runCompanion({
    // 传 undefined 会被参数默认值换成 ssh-remote，这里用 null 表示本机窗口。
    remoteName: null,
    until: (r) => r.length >= 2,
  });
  assert.equal(executed.filter((n) => n.startsWith('codexSwitcherRemote.')).length, 0);
  assert.equal(requests[0].remoteAgent, null);
  assert.equal(requests[0].authority, null);
});

test('read → write：回执带结果，写入服务器配置，记下待确认重载并只重启扩展宿主', async () => {
  let readResult;
  const next = original.replace('gpt-5.5', 'gpt-6.1-sol');
  const { requests, executed, state, home } = await runCompanion({
    commandsFor: (reqs) => {
      const read = reqs.find((r) => r.ack === 'cmd-read');
      if (!reqs.some((r) => r.ack === 'cmd-read'))
        return reqs.length === 1 ? { id: 'cmd-read', type: 'remoteApply', step: 'read' } : null;
      readResult = read.ackResult;
      return reqs.some((r) => r.ack === 'cmd-write')
        ? null
        : {
            id: 'cmd-write',
            type: 'remoteApply',
            step: 'write',
            text: next,
            expectedSha256: read.ackResult.sha256,
            catalog: '{"models":[]}',
            reload: true,
          };
    },
    until: acked('cmd-write'),
  });
  assert.deepEqual(readResult, { text: original, sha256: sha(original) });
  const write = requests.find((r) => r.ack === 'cmd-write');
  assert.equal(write.ackStatus, 'completed');
  assert.deepEqual(write.ackResult, { ok: true, sha256: sha(next), authSha256: null });
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), next);
  // 写入成功只回 completed，后台据此记为已请求重载；不再另发 reload_requested。
  assert.equal(requests.filter((r) => r.ack === 'cmd-write').length, 1);
  assert.deepEqual(state.get('codexSwitcher.pendingReload').commandId, 'cmd-write');
  // SSH 窗口不重载、不重连，只重启扩展宿主让服务器上的 Codex 换新后台。
  assert.ok(executed.includes('workbench.action.restartExtensionHost'));
  assert.equal(executed.includes('workbench.action.reloadWindow'), false);
});

// 远程窗口没有本机后端，连接状态一直是 unmatched；只能以后台的 reloadConfirmed 为准清掉待确认记录。
test('远程窗口重载后，后台确认前保留待确认记录，确认后清除', async () => {
  const pending = { clientId: 'old-window', commandId: 'cmd-write' };
  const { requests, state } = await runCompanion({
    pendingReload: pending,
    confirmFor: (reqs) => reqs.length >= 3,
    until: (reqs) => reqs.length >= 4,
  });
  const confirming = requests.filter((r) => r.completedReload);
  assert.equal(confirming.length, 3, '确认前每次心跳都应带 completedReload');
  assert.deepEqual(confirming[0].completedReload, pending);
  assert.equal(requests[3].completedReload, undefined, '确认后不再带');
  assert.equal(state.get('codexSwitcher.pendingReload'), undefined);
});

test('写入被拒绝时回执 failed 和原因，不重载、不改文件', async () => {
  const { requests, executed, home } = await runCompanion({
    commandsFor: (reqs) =>
      reqs.length === 1
        ? {
            id: 'cmd-write',
            type: 'remoteApply',
            step: 'write',
            text: 'model = "x"\n',
            expectedSha256: sha('stale'),
            catalog: null,
            reload: true,
          }
        : null,
    until: acked('cmd-write'),
  });
  const write = requests.find((r) => r.ack === 'cmd-write');
  assert.equal(write.ackStatus, 'failed');
  assert.match(write.ackError, /被修改过/);
  assert.equal(write.ackResult, undefined);
  assert.equal(
    executed.some((n) => /reloadWindow|restartExtensionHost/.test(n)),
    false,
  );
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), original);
});

// 假的官方登录：令牌是只含声明的 JWT，内容不是真实凭证。
const jwt = (payload) =>
  ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');
const login = (refresh) =>
  JSON.stringify({
    tokens: {
      id_token: jwt({
        email: 'team@example.com',
        'https://api.openai.com/auth': { chatgpt_plan_type: 'team' },
      }),
      access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'team' } }),
      refresh_token: 'rt-remote-secret',
      account_id: 'acct-1',
    },
    last_refresh: refresh,
  });

test('服务器有官方登录时心跳带账号摘要，不带令牌', async () => {
  const { requests } = await runCompanion({
    authText: login('2026-10-24T10:00:00Z'),
    until: (r) => r.length >= 1,
  });
  const { account } = requests[0].remoteAgent;
  assert.deepEqual(Object.keys(account).sort(), ['email', 'id', 'lastRefresh', 'plan']);
  assert.equal(account.email, 'team@example.com');
  assert.equal(account.lastRefresh, '2026-10-24T10:00:00Z');
  assert.equal(JSON.stringify(requests).includes('rt-remote-secret'), false);
});

test('readAuth → 只写登录：回执带登录正文和结果，配置不动，不重载', async () => {
  const older = login('2026-10-24T10:00:00Z'),
    newer = login('2026-10-25T10:00:00Z');
  const { requests, executed, home } = await runCompanion({
    authText: older,
    commandsFor: (reqs) => {
      const read = reqs.find((r) => r.ack === 'cmd-read-auth');
      if (!read)
        return reqs.length === 1
          ? { id: 'cmd-read-auth', type: 'remoteApply', step: 'readAuth' }
          : null;
      return reqs.some((r) => r.ack === 'cmd-sync')
        ? null
        : {
            id: 'cmd-sync',
            type: 'remoteApply',
            step: 'write',
            text: null,
            expectedSha256: null,
            catalog: null,
            auth: { text: newer, expectedSha256: read.ackResult.sha256 },
            reload: false,
          };
    },
    until: acked('cmd-sync'),
  });
  assert.deepEqual(requests.find((r) => r.ack === 'cmd-read-auth').ackResult, {
    text: older,
    sha256: sha(older),
  });
  const sync = requests.find((r) => r.ack === 'cmd-sync');
  assert.equal(sync.ackStatus, 'completed');
  assert.deepEqual(sync.ackResult, { ok: true, sha256: null, authSha256: sha(newer) });
  assert.equal(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'), newer);
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), original);
  assert.equal(
    executed.some((n) => /reloadWindow|restartExtensionHost/.test(n)),
    false,
  );
});

test('安装远端代理：写临时 VSIX 交给编辑器安装，装完删除临时文件', async () => {
  const vsix = Buffer.from('fake-vsix-bytes').toString('base64');
  const { requests, installed } = await runCompanion({
    commandsFor: (reqs) =>
      reqs.length === 1 ? { id: 'cmd-install', type: 'installRemoteAgent', base64: vsix } : null,
    until: acked('cmd-install'),
  });
  assert.equal(installed.length, 1);
  assert.equal(installed[0].bytes, 'fake-vsix-bytes');
  assert.equal(fs.existsSync(installed[0].path), false);
  const done = requests.find((r) => r.ack === 'cmd-install');
  assert.equal(done.ackStatus, 'completed');
  assert.deepEqual(done.ackResult, { installed: true });
});

test('安装失败时回执 failed，临时文件同样删除', async () => {
  const vsix = Buffer.from('x').toString('base64');
  const { requests } = await runCompanion({
    installFails: true,
    commandsFor: (reqs) =>
      reqs.length === 1 ? { id: 'cmd-install', type: 'installRemoteAgent', base64: vsix } : null,
    until: acked('cmd-install'),
  });
  const done = requests.find((r) => r.ack === 'cmd-install');
  assert.equal(done.ackStatus, 'failed');
  assert.equal(done.ackError, 'install failed');
  const leftovers = fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith('codex-switcher-remote-'));
  assert.deepEqual(leftovers, []);
});
