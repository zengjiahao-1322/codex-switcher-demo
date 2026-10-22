'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  { DatabaseSync } = require('node:sqlite');
const { listThreads, diagnose, exportContext } = require('../src/diagnostics/diagnostics.cjs'),
  { writeJson } = require('../src/accounts/accounts.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-diagnosis-')),
    home = path.join(root, 'home'),
    bridge = path.join(root, 'bridge');
  fs.mkdirSync(home);
  fs.mkdirSync(bridge);
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    'model="api-model"\nmodel_provider="hermes_bridge"\n[model_providers.hermes_bridge]\nbase_url="http://localhost:1/v1"\nrequires_openai_auth=false\n',
  );
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.exec(
    'CREATE TABLE threads (id TEXT PRIMARY KEY,title TEXT,updated_at INTEGER,model TEXT,model_provider TEXT,archived INTEGER,source TEXT,rollout_path TEXT,cwd TEXT,creator_account_id TEXT,creator_user_id TEXT)',
  );
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, bridge, db };
}
function session(f, id, provider, items = []) {
  const file = path.join(f.home, id + '.jsonl');
  fs.writeFileSync(file, items.map((x) => JSON.stringify(x)).join('\n') + '\n');
  f.db
    .prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, '会话 ' + id, 1, 'old-model', provider, 0, 'vscode', file, f.root, null, null);
  return file;
}
test('specific diagnosis distinguishes missing provider, official identity and correlated encrypted error', async (t) => {
  const f = fixture(t),
    file = session(f, 'old', 'removed-provider', [
      {
        type: 'event_msg',
        timestamp: '2026-01-01T00:00:00Z',
        payload: { type: 'error', message: 'invalid_encrypted_content' },
      },
    ]);
  const before = fs.readFileSync(file);
  const logs = new DatabaseSync(path.join(f.home, 'logs_2.sqlite'));
  logs.exec(
    'CREATE TABLE logs (id INTEGER,ts INTEGER,level TEXT,thread_id TEXT,feedback_log_body TEXT)',
  );
  logs
    .prepare('INSERT INTO logs VALUES (1,1,?,?,?)')
    .run('ERROR', 'old', '401 unauthorized secret-should-not-return');
  logs.close();
  const r = await diagnose({ codexHome: f.home, bridgeHome: f.bridge, id: 'old' });
  assert.ok(r.findings.some((x) => /供应商没有定义/.test(x.title)));
  assert.ok(r.findings.some((x) => /加密内容/.test(x.title)));
  assert.ok(r.findings.some((x) => /鉴权失败/.test(x.title)));
  assert.equal(JSON.stringify(r).includes('secret-should-not-return'), false);
  assert.deepEqual(fs.readFileSync(file), before);
  session(f, 'official', 'openai');
  const official = await diagnose({ codexHome: f.home, bridgeHome: f.bridge, id: 'official' });
  assert.ok(official.actions.some((x) => x.type === 'reapply'));
  assert.equal(listThreads(f.home, { query: 'official' }).items.length, 1);
});

test('过期 access token 先用官方 session 验证，不直接提示重新登录', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'config.toml'), 'model="gpt-test"\n');
  const token = (payload) =>
    [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify(payload)).toString('base64url'),
      'fixture',
    ].join('.');
  writeJson(path.join(f.home, 'auth.json'), {
    tokens: {
      access_token: token({
        exp: 1,
        sub: 'user-1',
        'https://api.openai.com/auth': { chatgpt_user_id: 'user-1' },
      }),
      id_token: token({ email: 'fixture@example.test', sub: 'user-1' }),
      account_id: 'account-1',
    },
  });
  let calls = 0;
  const result = await diagnose({
    codexHome: f.home,
    bridgeHome: f.bridge,
    accounts: {
      prepare: async (id) => {
        calls++;
        assert.equal(typeof id, 'string');
      },
    },
  });
  assert.equal(calls, 1);
  assert.ok(result.findings.some((x) => /官方登录仍可用/.test(x.title)));
  assert.equal(
    result.actions.some((x) => x.type === 'reauth'),
    false,
  );
  // 判断只依赖错误类型，网络文案里含“重新登录”也不能误判。
  for (const kind of ['network_error', 'runtime_error', 'service_error', 'auth_invalid']) {
    const failure = await diagnose({
      codexHome: f.home,
      bridgeHome: f.bridge,
      accounts: {
        prepare: async () => {
          throw Object.assign(Error('提示里包含重新登录，但类型决定处理方式'), { kind });
        },
      },
    });
    assert.equal(
      failure.actions.some((x) => x.type === 'reauth'),
      kind === 'auth_invalid',
    );
  }
});

test('editor reload failure stays visible after the request was acknowledged', (t) => {
  const f = fixture(t);
  const clients = require('../src/clients/client-status.cjs');
  const identity = { id: 'editor-reload-failed', pid: 123, home: f.home };
  clients.heartbeat(f.bridge, identity);
  const file = path.join(f.bridge, 'clients', identity.id + '.json');
  const row = JSON.parse(fs.readFileSync(file, 'utf8'));
  writeJson(file, { ...row, command: { id: 'request-123', type: 'reload' } });
  clients.heartbeat(f.bridge, { ...identity, ack: 'request-123', ackStatus: 'reload_requested' });
  clients.heartbeat(f.bridge, {
    ...identity,
    ack: 'request-123',
    ackStatus: 'reload_failed',
    ackError: 'window command failed',
  });
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(result.command, null);
  assert.equal(result.lastAck.status, 'reload_failed');
  assert.equal(result.lastAck.error, 'window command failed');
});
test('context export preserves repeated visible messages and omits hidden reasoning and tools', async (t) => {
  const f = fixture(t),
    visible = (role, text, channel) => ({
      type: 'response_item',
      payload: {
        type: 'message',
        role,
        channel,
        content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
      },
    });
  const file = session(f, 'export', 'hermes_bridge', [
    visible('user', 'repeat'),
    visible('assistant', 'visible'),
    visible('user', 'repeat'),
    visible('assistant', 'HIDDEN_ANALYSIS', 'analysis'),
    {
      type: 'response_item',
      payload: { type: 'reasoning', encrypted_content: 'HIDDEN_ENCRYPTED' },
    },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'TOOL_SECRET' } },
  ]);
  const before = fs.readFileSync(file);
  const result = await exportContext(f.home, f.bridge, 'export'),
    text = fs.readFileSync(result.file, 'utf8');
  assert.equal(result.messages, 3);
  assert.equal(text.match(/repeat/g).length, 2);
  assert.match(text, /visible/);
  assert.doesNotMatch(text, /HIDDEN|TOOL_SECRET/);
  assert.deepEqual(fs.readFileSync(file), before);
});
test('window registry reloads only confirmed shared-home editor and records acknowledgement', (t) => {
  const f = fixture(t),
    c = require('../src/clients/client-status.cjs'),
    other = path.join(f.root, 'other');
  fs.mkdirSync(other);
  c.heartbeat(f.bridge, { id: 'editor-shared', pid: 100, name: 'VS Code', home: f.home });
  c.heartbeat(f.bridge, { id: 'editor-other', pid: 200, name: 'VS Code', home: other });
  const inventory = {
    ancestry: [
      { pid: 100, parentPid: 1, name: 'Code.exe' },
      { pid: 200, parentPid: 2, name: 'Code.exe' },
    ],
    processes: [
      {
        pid: 101,
        parentPid: 100,
        exe: 'codex.exe',
        startedAt: new Date().toISOString(),
        context: { ok: true, home: f.home, cwd: f.root, overrides: {} },
      },
      {
        pid: 201,
        parentPid: 200,
        exe: 'codex.exe',
        startedAt: new Date().toISOString(),
        context: { ok: true, home: other, cwd: f.root, overrides: {} },
      },
    ],
  };
  const status = c.snapshot(f.home, f.bridge, { inventory }),
    editors = status.clients.filter((x) => x.kind === 'editor');
  assert.equal(editors.find((x) => x.editorId === 'editor-shared').canReload, true);
  assert.equal(editors.find((x) => x.editorId === 'editor-other').canReload, false);
  const request = { id: 'reload-1', type: 'reload' };
  const file = path.join(f.bridge, 'clients', 'editor-shared.json'),
    row = JSON.parse(fs.readFileSync(file));
  writeJson(file, { ...row, command: request });
  assert.equal(c.heartbeat(f.bridge, { id: 'editor-shared', pid: 100 }).command.id, 'reload-1');
  c.heartbeat(f.bridge, { id: 'editor-shared', pid: 100, ack: 'reload-1' });
  assert.equal(JSON.parse(fs.readFileSync(file)).command, null);
});

test('Windows 与 Mac 的编辑器由 Codex 桌面端启动时，插件仍归属最近的编辑器宿主', (t) => {
  const f = fixture(t),
    c = require('../src/clients/client-status.cjs');
  for (const [desktop, editor] of [
    ['C:/OpenAI.Codex_test/app/Codex.exe', 'Code.exe'],
    ['/Applications/Codex.app/Contents/MacOS/Codex', 'Code Helper (Plugin)'],
  ]) {
    const status = c.snapshot(f.home, f.bridge, {
      inventory: {
        ancestry: [
          { pid: 50, parentPid: 1, exe: desktop, name: 'Codex' },
          { pid: 100, parentPid: 50, name: editor },
        ],
        processes: [
          { pid: 101, parentPid: 100, exe: 'codex', context: { ok: true, home: f.home } },
        ],
      },
    });
    assert.equal(status.clients[0].kind, 'ide');
    assert.equal(status.clients[0].desktopPid, null);
  }
});

test('同一 VS Code 实例的窗口共用通信标识时，按扩展宿主进程关联后端', (t) => {
  const f = fixture(t),
    c = require('../src/clients/client-status.cjs');
  c.heartbeat(f.bridge, {
    id: 'window-first',
    pid: 810,
    windowKey: 'same-vscode-instance',
    home: f.home,
  });
  c.heartbeat(f.bridge, {
    id: 'window-second',
    pid: 820,
    windowKey: 'same-vscode-instance',
    home: f.home,
  });
  const inventory = {
    ancestry: [
      { pid: 810, parentPid: 1, name: 'Code Helper (Plugin)' },
      { pid: 820, parentPid: 1, name: 'Code Helper (Plugin)' },
    ],
    processes: [810, 820].map((parentPid) => ({
      pid: parentPid + 1,
      parentPid,
      exe: '/extensions/openai.chatgpt/bin/codex',
      context: { ok: true, home: f.home, windowKey: 'same-vscode-instance' },
    })),
  };
  const rows = c.snapshot(f.home, f.bridge, { inventory }).clients;
  assert.equal(rows.find((p) => p.pid === 811).editorId, 'window-first');
  assert.equal(rows.find((p) => p.pid === 821).editorId, 'window-second');
  assert.equal(rows.filter((p) => p.kind === 'editor' && p.canReload).length, 2);
  const ambiguous = c.snapshot(f.home, f.bridge, {
    inventory: { ...inventory, processes: [{ ...inventory.processes[0], parentPid: 999 }] },
  });
  assert.equal(ambiguous.clients.find((p) => p.kind === 'ide').editorId, null);
});

test('远程窗口或 WSL 设置不应否定真实本地后端的 PID 归属', (t) => {
  const f = fixture(t),
    c = require('../src/clients/client-status.cjs');
  for (const flags of [{ remote: 'ssh-remote+fixture' }, { wsl: true }]) {
    const id = flags.remote ? 'window-remote-local' : 'window-wsl-local';
    c.heartbeat(f.bridge, { id, pid: 810, home: null, ...flags });
    const inventory = {
      ancestry: [{ pid: 810, parentPid: 1, name: 'Code Helper (Plugin)' }],
      processes: [{ pid: 811, parentPid: 810, exe: 'codex', context: { ok: true, home: f.home } }],
    };
    const result = c.snapshot(f.home, f.bridge, { inventory });
    assert.equal(result.clients.find((p) => p.pid === 811).editorId, id);
    assert.equal(
      result.clients.find((p) => p.kind === 'editor' && p.editorId === id).canReload,
      true,
    );
    fs.rmSync(path.join(f.bridge, 'clients', id + '.json'));
  }
});

test('心跳返回真实后端关联结果，已连接不能代替已接入', async (t) => {
  const f = fixture(t),
    clients = require('../src/clients/client-status.cjs');
  const inventory = {
    ancestry: [{ pid: 810, parentPid: 1, name: 'Code Helper (Plugin)' }],
    processes: [],
  };
  t.mock.method(clients, 'scanAsync', async () => inventory);
  const service = require('../src/server/service.cjs').createService({
    codexHome: f.home,
    bridgeHome: f.bridge,
    hermesHome: path.join(f.root, 'no-hermes'),
  });
  const input = { id: 'connected-window', pid: 810, remote: 'ssh-remote+fixture' };
  const pending = await service.actions.clientHeartbeat(input);
  assert.equal(pending.connection.state, 'unmatched');
  assert.deepEqual(pending.connection.backendPids, []);
  inventory.processes.push({
    pid: 811,
    parentPid: 810,
    exe: 'codex',
    context: { ok: true, home: f.home },
  });
  const ready = await service.actions.clientHeartbeat(input);
  assert.equal(ready.connection.state, 'ready');
  assert.deepEqual(ready.connection.backendPids, [811]);
  const rowFile = path.join(f.bridge, 'clients', input.id + '.json');
  const row = JSON.parse(fs.readFileSync(rowFile));
  writeJson(rowFile, { ...row, command: { id: 'linked-reload', type: 'reload' } });
  assert.equal((await service.actions.clientHeartbeat(input)).command.id, 'linked-reload');
  clients.heartbeat(f.bridge, { ...input, ack: 'linked-reload', ackStatus: 'reload_requested' });
  const newInput = {
    ...input,
    id: 'reloaded-window',
    completedReload: { clientId: input.id, commandId: 'linked-reload' },
  };
  inventory.processes.length = 0;
  await service.actions.clientHeartbeat(newInput);
  const targets = [{ id: input.id, commandId: 'linked-reload' }];
  assert.equal(clients.reloadResults(f.bridge, targets)[0].status, 'received');
  fs.rmSync(rowFile);
  inventory.processes.push({
    pid: 812,
    parentPid: 810,
    exe: 'codex',
    context: { ok: true, home: f.home },
  });
  // 重载后的老宿主不再心跳，实际窗口由新编号注册。
  writeJson(rowFile, { ...row, lastAck: { id: 'linked-reload', status: 'reload_requested' } });
  const oldInputRow = JSON.parse(fs.readFileSync(rowFile));
  oldInputRow.pid = 809;
  writeJson(rowFile, oldInputRow);
  await service.actions.clientHeartbeat(newInput);
  assert.equal(clients.reloadResults(f.bridge, targets)[0].status, 'reloaded');
  fs.rmSync(rowFile);
  inventory.processes[0].context.home = path.join(f.root, 'independent');
  const independent = await service.actions.clientHeartbeat({
    ...newInput,
    completedReload: undefined,
  });
  assert.equal(independent.connection.state, 'separate');
  assert.equal(
    clients.snapshot(f.home, f.bridge, { inventory }).clients.find((c) => c.kind === 'editor')
      .canReload,
    false,
  );
  // 远程工作区的本机伴随扩展没有本机 Codex 后端时，不能凭同目录声明取得重载资格。
  inventory.processes.length = 0;
  assert.equal(
    (
      await service.actions.clientHeartbeat({
        ...newInput,
        completedReload: undefined,
        home: f.home,
      })
    ).connection.state,
    'unmatched',
  );
});
test('桌面壳尚无后端时仍识别 Codex，独立目录不跟随', (t) => {
  const f = fixture(t),
    c = require('../src/clients/client-status.cjs');
  const shells = [
    'C:/Program Files/WindowsApps/OpenAI.Codex_demo/app/ChatGPT.exe',
    '/Applications/Codex.app/Contents/MacOS/Codex',
    '/Applications/Codex.app/Contents/MacOS/ChatGPT',
  ];
  for (const exe of shells) {
    const p = { pid: 500, parentPid: 1, exe, context: { ok: true, home: f.home, overrides: {} } };
    const status = c.snapshot(f.home, f.bridge, { inventory: { ancestry: [], processes: [p] } });
    assert.equal(status.desktop, true);
    assert.equal(status.clients[0].desktopExecutable, exe);
    assert.equal(status.clients[0].shared, true);
    const mixed = { clients: [...status.clients, { kind: 'ide', shared: true, confirmed: true }] };
    const choose = require('../src/clients/desktop-account.cjs').desktopForClients;
    assert.equal(choose(mixed, () => assert.fail('use confirmed desktop path')).exe, exe);
    const separate = c.snapshot(path.join(f.root, 'other'), f.bridge, {
      inventory: { ancestry: [], processes: [p] },
    });
    assert.equal(separate.clients[0].shared, false);
    assert.equal(choose({ clients: [...separate.clients, mixed.clients.at(-1)] }), null);
  }
  const backend = {
    pid: 600,
    parentPid: 1,
    exe: 'C:/Users/demo/AppData/Local/OpenAI/Codex/bin/hash/codex.exe',
    context: { ok: true, home: f.home, overrides: {} },
  };
  assert.equal(
    c.snapshot(f.home, f.bridge, { inventory: { ancestry: [], processes: [backend] } }).desktop,
    false,
  );
});

test('有真实后端时不重复显示桌面壳，并以实际后端的目录为准', (t) => {
  const f = fixture(t),
    c = require('../src/clients/client-status.cjs');
  const shell = {
    pid: 700,
    parentPid: 1,
    exe: '/Applications/Codex.app/Contents/MacOS/Codex',
    context: { ok: true, home: f.home },
  };
  const backend = {
    pid: 701,
    parentPid: 700,
    exe: '/Applications/Codex.app/Contents/Resources/codex',
    context: { ok: true, home: path.join(f.root, 'separate') },
  };
  const status = c.snapshot(f.home, f.bridge, {
    inventory: { ancestry: [shell], processes: [shell, backend] },
  });
  const desktops = status.clients.filter((p) => p.kind === 'desktop');
  assert.equal(desktops.length, 1);
  assert.equal(desktops[0].pid, backend.pid);
  assert.equal(desktops[0].shared, false);
  assert.deepEqual(
    c.desktopTargets(shell.exe, f.home, {
      inventory: { ancestry: [shell], processes: [shell, backend] },
    }),
    [],
  );
  backend.context.home = f.home;
  const sharedInventory = { ancestry: [shell], processes: [shell, backend] };
  assert.equal(c.snapshot(f.home, f.bridge, { inventory: sharedInventory }).clients.length, 1);
  assert.deepEqual(c.desktopTargets(shell.exe, f.home, { inventory: sharedInventory }), [
    shell.pid,
  ]);
});

test('Mac 普通 ChatGPT 应用不参与 Codex 的发现和重启', (t) => {
  const f = fixture(t),
    cp = require('node:child_process');
  const run = cp.execFileSync;
  t.mock.method(cp, 'execFileSync', (exe, args, options) =>
    exe === '/bin/ps'
      ? '90001 1 00:10 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n90002 1 00:10 /Applications/Codex.app/Contents/MacOS/ChatGPT\n'
      : run(exe, args, options),
  );
  const inventory = require('../src/platform/mac-processes.cjs').scan();
  assert.equal(
    inventory.processes.some((p) => p.pid === 90001),
    false,
  );
  assert.equal(
    inventory.processes.some((p) => p.pid === 90002),
    true,
  );
  const ordinary = {
    pid: 90001,
    exe: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    context: { ok: true, home: f.home },
  };
  assert.equal(
    require('../src/clients/client-status.cjs').snapshot(f.home, f.bridge, {
      inventory: { ancestry: [], processes: [ordinary] },
    }).desktop,
    false,
  );
});
