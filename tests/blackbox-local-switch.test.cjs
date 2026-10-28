'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const toml = require('smol-toml');
const { api, isolatedEditor, read } = require('./config-blackbox-helpers.cjs');
const {
  auth,
  accountId,
  officialFixture,
  accounts,
  until,
} = require('./official-blackbox-helpers.cjs');
const job = (f) => JSON.parse(fs.readFileSync(path.join(f.bridge, 'account-switch.json')));
const finish = (f) =>
  until(
    async () => job(f),
    (s) => ['done', 'error'].includes(s.status),
    30000,
  );
async function fixture(t, options = {}) {
  const f = await officialFixture(t, { ...options, live: auth('target', options.target) });
  f.targetAuth = JSON.parse(read(f, 'auth.json'));
  await accounts(f);
  fs.writeFileSync(path.join(f.home, 'auth.json'), JSON.stringify(auth('outgoing')));
  await accounts(f);
  await isolatedEditor(t, f);
  return f;
}
const registration = (f) => ({
  id: 'fixture-editor',
  pid: process.pid,
  home: f.home,
  name: 'Fixture editor',
  reloadProtocol: 3,
});
test('切换进程黑盒：锁交接和queued先落盘，原后台退出后仍完成任务', async (t) => {
  const f = await fixture(t, {
    target: { exp: 1 },
    scenario: {
      methods: {
        initialize: { result: {} },
        'account/read': { waitFile: 'worker-continue', result: { account: { type: 'chatgpt' } } },
      },
    },
  });
  const before = read(f, 'auth.json');
  await api(f, 'accountSwitch', {
    id: accountId('target'),
    reloadEditors: false,
    threadFollow: 'off',
  });
  await until(
    async () => f.rpc(),
    (rows) => rows.some((row) => row.method === 'account/read'),
  );
  const queued = job(f);
  assert.notEqual(queued.pid, f.child.pid);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.bridge, 'operation.lock'))).pid, queued.pid);
  assert.equal(read(f, 'auth.json'), before);
  const exited = require('node:events').once(f.child, 'exit');
  f.child.kill();
  await exited;
  assert.doesNotThrow(() => process.kill(queued.pid, 0));
  fs.writeFileSync(path.join(f.root, 'worker-continue'), 'go');
  const finished = await finish(f);
  assert.equal(finished.status, 'done', JSON.stringify(finished));
  assert.equal(finished.pid, queued.pid);
  assert.equal(finished.configurationApplied, true);
  assert.deepEqual(JSON.parse(read(f, 'auth.json')), auth('target', { exp: 1 }));
  await until(
    async () => fs.existsSync(path.join(f.bridge, 'operation.lock')),
    (exists) => !exists,
  );
});
test('本机切换黑盒：相同模型换号也先停止真实旧后端，选文件凭据并发送编号重载', async (t) => {
  const f = await fixture(t);
  const before = await api(f, 'clients', {});
  const old = before.clients.find((c) => c.kind === 'ide' && c.shared);
  assert.ok(old && old.confirmed);
  fs.writeFileSync(
    path.join(f.home, 'config.toml'),
    '# keep\nmodel="same"\ncli_auth_credentials_store="keyring"\n',
  );
  await api(f, 'accountSwitch', {
    id: accountId('target'),
    threadFollow: 'off',
    source: 'vscode-local',
  });
  const result = await finish(f);
  assert.equal(result.status, 'done', JSON.stringify({ result, rpc: f.rpc() }));
  assert.notEqual(result.pid, f.child.pid, 'A switch uses an independent worker');
  assert.equal(result.desktopRequested, false);
  assert.equal(result.configurationApplied, true);
  assert.equal(read(f), 'model = "same"\ncli_auth_credentials_store = "file"\n# keep\n');
  assert.deepEqual(JSON.parse(read(f, 'auth.json')), f.targetAuth);
  await until(
    async () => api(f, 'clients', {}),
    (s) => !s.clients.some((c) => c.pid === old.pid),
    6000,
  );
  assert.equal(result.editorReload.count, 1);
  assert.equal(result.editorReload.targets[0].id, 'fixture-editor');
  const cmd = (await api(f, 'clientHeartbeat', registration(f))).command;
  assert.equal(cmd.type, 'reload');
  assert.equal(cmd.id, result.editorReload.targets[0].commandId);
  await api(f, 'clientHeartbeat', {
    ...registration(f),
    ack: cmd.id,
    ackStatus: 'reload_failed',
    ackError: 'fixture visible failure',
  });
  const current = await api(f, 'accounts', {});
  assert.equal(current.switchJob.editorReload.results[0].status, 'failed');
  assert.equal(current.switchJob.editorReload.results[0].error, 'fixture visible failure');
  assert.equal(f.rpc().filter((r) => /^thread\//.test(r.method)).length, 0);
});
test('本机切换黑盒：准备拒绝保留登录、配置、目录和真实客户端，释放后可重试', async (t) => {
  const f = await fixture(t, {
    target: { exp: 1 },
    scenario: {
      methods: {
        initialize: { result: {} },
        'account/read': { error: { code: 401, message: 'Unauthorized fixture' } },
      },
    },
  });
  const config = read(f),
    live = read(f, 'auth.json');
  const before = await api(f, 'clients', {});
  const old = before.clients.find((c) => c.kind === 'ide' && c.shared);
  await api(f, 'accountSwitch', { id: accountId('target'), threadFollow: 'off' });
  const result = await finish(f);
  assert.equal(result.status, 'error');
  assert.equal(result.configurationApplied, false);
  assert.equal(read(f), config);
  assert.equal(read(f, 'auth.json'), live);
  assert.ok((await api(f, 'clients', {})).clients.some((c) => c.pid === old.pid));
  assert.equal(fs.existsSync(path.join(f.bridge, 'model-catalog.json')), false);
  await until(
    async () => fs.existsSync(path.join(f.bridge, 'operation.lock')),
    (v) => !v,
  );
  await api(f, 'providerAdd', {
    name: 'after failure',
    baseUrl: 'https://example.test/v1',
    apiMode: 'responses',
    apiKey: 'fixture',
    model: 'm',
  });
  const events = fs
    .readFileSync(path.join(f.bridge, 'logs/switcher.log'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const relevant = events.filter((e) => /^switch\./.test(e.event));
  assert.equal(relevant[0].event, 'switch.start');
  assert.ok(relevant.some((e) => e.event === 'switch.clients'));
  assert.ok(
    relevant.some((e) => e.event === 'switch.step' && e.id === 'prepare' && e.status === 'error'),
  );
  assert.equal(relevant.at(-1).status, 'error');
});
test('本机切换黑盒：等待并行准备收尾时锁拒绝第二实例修改，准备完成后才应用', async (t) => {
  const f = await fixture(t, {
    target: { exp: 1 },
    scenario: {
      methods: {
        initialize: { result: {} },
        'account/read': {
          waitFile: 'release-preparation',
          result: { account: { type: 'chatgpt' } },
        },
      },
    },
  });
  const config = read(f),
    live = read(f, 'auth.json');
  await api(f, 'accountSwitch', { id: accountId('target'), threadFollow: 'off' });
  await until(
    async () => f.rpc(),
    (rows) => rows.some((r) => r.method === 'account/read' && r.params.refreshToken),
  );
  const blocked = await api(
    f,
    'providerAdd',
    {
      name: 'blocked',
      baseUrl: 'https://example.test/v1',
      apiMode: 'responses',
      apiKey: 'fixture',
      model: 'm',
    },
    400,
  );
  assert.match(blocked.error, /正在|操作/);
  assert.equal(read(f), config);
  assert.equal(read(f, 'auth.json'), live);
  assert.equal(job(f).configurationApplied, false);
  await isolatedEditor(t, f);
  const during = await api(f, 'clients', {});
  const shared = during.clients.filter((c) => c.kind === 'ide' && c.confirmed && c.shared);
  assert.equal(shared.length, 2);
  fs.writeFileSync(path.join(f.root, 'release-preparation'), 'go');
  const completed = await finish(f);
  assert.equal(completed.status, 'done', JSON.stringify(completed));
  assert.deepEqual(JSON.parse(read(f, 'auth.json')), auth('target', { exp: 1 }));
  await until(
    async () => api(f, 'clients', {}),
    (status) => !status.clients.some((c) => shared.some((previous) => previous.pid === c.pid)),
    6000,
  );
});
test('本机切换黑盒：API准备失败保留全文与模型目录，后台记录明确失败', async (t) => {
  const f = await fixture(t, {
    scenario: {
      methods: { initialize: { error: { code: -32000, message: 'fixture validation rejected' } } },
    },
  });
  const { id } = await api(f, 'providerAdd', {
    name: 'API fixture',
    baseUrl: 'https://example.test/v1',
    apiMode: 'responses',
    model: 'm',
    models: ['m'],
    apiKey: 'fixture',
  });
  const store = require('../src/config/providers.cjs');
  store.recordProbe(
    f.bridge,
    store.list(f.bridge).find((p) => p.id === id),
    'm',
    'direct',
    'fixture-direct',
  );
  const config = read(f),
    live = read(f, 'auth.json');
  const catalog = path.join(f.bridge, 'model-catalog.json');
  fs.writeFileSync(catalog, '{"models":[{"slug":"preserve"}]}');
  const originalCatalog = fs.readFileSync(catalog, 'utf8');
  await api(f, 'desktopSwitch', { id, model: 'm', source: 'unrecognized' }, 400);
  assert.equal(fs.existsSync(path.join(f.bridge, 'account-switch-job.json')), false);
  await api(f, 'desktopSwitch', { id, model: 'm', threadFollow: 'off', source: 'vscode-local' });
  const result = await finish(f);
  assert.equal(result.status, 'error');
  assert.equal(result.configurationApplied, false);
  assert.equal(read(f), config);
  assert.equal(read(f, 'auth.json'), live);
  assert.equal(fs.readFileSync(catalog, 'utf8'), originalCatalog);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.bridge, 'account-switch-job.json'))).source,
    'vscode-local',
  );
});
test('本机切换黑盒：IDE-only缺少模型和缓存仍换号，没有共享编辑器时不释放或重载', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.home, 'config.toml'), '# no default model\n');
  await api(f, 'accountSwitch', {
    id: accountId('target'),
    reloadEditors: false,
    threadFollow: 'off',
  });
  const result = await finish(f);
  assert.equal(result.status, 'done', JSON.stringify(result));
  assert.equal(result.desktopRequested, false);
  assert.equal(result.editorReload ?? null, null);
  assert.equal(read(f), 'cli_auth_credentials_store = "file"\n# no default model\n');
  assert.equal(toml.parse(read(f)).model, undefined);
  assert.ok((await api(f, 'clients', {})).clients.some((c) => c.kind === 'ide' && c.shared));
});
test('旧对话同步黑盒：切换后通过同一官方RPC冷启动核对来源、模型和速度', async (t) => {
  const f = await fixture(t, {
    scenario: {
      methods: {
        initialize: { result: {} },
        'account/read': { result: { account: { type: 'chatgpt' } } },
        'model/list': { result: { data: [{ model: 'new-model', isDefault: true }] } },
        'thread/resume': {
          result: { modelProvider: 'openai', model: 'new-model', serviceTier: 'priority' },
        },
        'thread/read': {
          result: {
            thread: { modelProvider: 'openai', model: 'new-model', serviceTier: 'priority' },
          },
        },
        'thread/unsubscribe': { result: {} },
      },
    },
  });
  const { DatabaseSync } = require('node:sqlite');
  const rollout = path.join(f.root, 'thread.jsonl');
  fs.writeFileSync(
    rollout,
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'priority' } },
    }) + '\n',
  );
  const db = new DatabaseSync(path.join(f.home, 'state_5.sqlite'));
  db.exec(
    'CREATE TABLE threads (id TEXT, model_provider TEXT, model TEXT, rollout_path TEXT, archived INTEGER, source TEXT)',
  );
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run(
    'thread-1',
    'openai',
    'old-model',
    rollout,
    0,
    '{}',
  );
  db.close();
  fs.writeFileSync(
    path.join(f.home, 'config.toml'),
    'model="new-model"\nmodel_provider="openai"\n',
  );
  await api(f, 'accountSwitch', {
    id: accountId('target'),
    threadFollow: 'all',
    reloadEditors: false,
  });
  const result = await finish(f);
  assert.equal(result.status, 'done', JSON.stringify({ result, rpc: f.rpc() }));
  assert.deepEqual(result.threads, { updated: 1, skipped: 0, failed: 0 });
  assert.equal(read(f), 'model = "new-model"\ncli_auth_credentials_store = "file"\n');
  assert.equal(f.rpc().filter((r) => r.method === 'thread/resume').length >= 1, true);
});

test('旧对话失败黑盒：失败保持未完成并恢复编辑器，继续同步不重复应用账号', async (t) => {
  const f = await fixture(t, {
    scenario: {
      methods: {
        initialize: { result: {} },
        'model/list': { result: { data: [{ model: 'blackbox-fixture', isDefault: true }] } },
        'thread/resume': { error: { code: -32000, message: 'active writer fixture' } },
        'thread/read': {
          result: { thread: { modelProvider: 'openai', model: 'blackbox-fixture' } },
        },
        'thread/unsubscribe': { result: {} },
      },
    },
  });
  const { DatabaseSync } = require('node:sqlite');
  const rollout = path.join(f.root, 'thread.jsonl');
  fs.writeFileSync(rollout, '{}\n');
  const db = new DatabaseSync(path.join(f.home, 'state_5.sqlite'));
  db.exec(
    'CREATE TABLE threads (id TEXT, model_provider TEXT, model TEXT, rollout_path TEXT, archived INTEGER, source TEXT)',
  );
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run(
    'thread-1',
    'other',
    'old-model',
    rollout,
    0,
    '{}',
  );
  db.close();
  await api(f, 'accountSwitch', { id: accountId('target') });
  const failed = await finish(f);
  assert.equal(failed.status, 'error');
  assert.equal(failed.configurationApplied, true);
  assert.equal(failed.threads.failed, 1);
  assert.equal(failed.editorReload.count, 1);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.bridge, 'effect.json'))).status,
    'switch_incomplete',
  );
  const config = read(f),
    applied = read(f, 'auth.json');
  f.update((s) => {
    s.methods['thread/resume'] = { result: { modelProvider: 'openai', model: 'blackbox-fixture' } };
  });
  await until(
    async () => fs.existsSync(path.join(f.bridge, 'operation.lock')),
    (v) => !v,
  );
  await api(f, 'resumeThreadSync', { source: 'vscode-local' });
  const result = await finish(f);
  assert.equal(result.status, 'done', JSON.stringify(result));
  assert.equal(result.threads.updated, 1);
  assert.equal(read(f), config);
  assert.equal(read(f, 'auth.json'), applied);
});

test('并行准备失败黑盒：缺重载通道时等另一校验收尾，保留锁和客户端且有进程链日志', async (t) => {
  const f = await fixture(t, {
    target: { exp: 1 },
    scenario: {
      methods: {
        initialize: { result: {} },
        'account/read': { waitFile: 'release-check', result: { account: { type: 'chatgpt' } } },
      },
    },
  });
  fs.unlinkSync(path.join(f.bridge, 'clients', 'fixture-editor.json'));
  const exe = path.join(
    f.root,
    'openai.chatgpt-fixture',
    process.platform === 'win32' ? 'codex.exe' : 'codex',
  );
  fs.mkdirSync(path.dirname(exe));
  fs.copyFileSync(f.environment.CODEX_EXE, exe);
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  const child = require('node:child_process').spawn(exe, ['app-server'], {
    cwd: f.root,
    env: f.environment,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  f.track(child);
  child.stderr.resume();
  const ready = require('node:events').once(child.stdout, 'data');
  child.stdin.write('{"id":1,"method":"initialize","params":{}}\n');
  await ready;
  await until(
    async () => api(f, 'clients', {}),
    (s) => s.clients.some((c) => c.pid === child.pid && c.kind === 'ide' && !c.editorId),
  );
  const config = read(f),
    live = read(f, 'auth.json');
  await api(f, 'accountSwitch', { id: accountId('target'), threadFollow: 'off' });
  await until(
    async () => f.rpc(),
    (rows) => rows.some((r) => r.method === 'account/read'),
  );
  assert.ok(fs.existsSync(path.join(f.bridge, 'operation.lock')));
  assert.ok(!['done', 'error'].includes(job(f).status));
  await until(
    async () => fs.readFileSync(path.join(f.bridge, 'logs/switcher.log'), 'utf8'),
    (log) => log.includes('switch.clients') && log.includes(String(child.pid)),
  );
  assert.equal(read(f), config);
  assert.equal(read(f, 'auth.json'), live);
  fs.writeFileSync(path.join(f.root, 'release-check'), 'go');
  const failed = await finish(f);
  assert.equal(failed.status, 'error');
  assert.match(failed.message, /未关联/);
  const events = fs
    .readFileSync(path.join(f.bridge, 'logs/switcher.log'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const snapshot = events.find((e) => e.event === 'switch.clients');
  assert.ok(
    snapshot.clients.some(
      (c) => c.pid === child.pid && c.chain.some((p) => p.includes(child.pid + ':')),
    ),
  );
  assert.equal(read(f), config);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
});
