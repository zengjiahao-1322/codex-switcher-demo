'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const toml = require('smol-toml');
const { api, isolatedEditor, read } = require('./config-blackbox-helpers.cjs');
const { auth, accountId, officialFixture, accounts, until } = require('./official-blackbox-helpers.cjs');
const job = (f) => JSON.parse(fs.readFileSync(path.join(f.bridge, 'account-switch.json')));
const finish = (f) => until(async () => job(f), s => ['done', 'error'].includes(s.status), 30000);
async function fixture(t, options = {}) {
  const f = await officialFixture(t, { ...options, live: auth('target', options.target) });
  f.targetAuth = JSON.parse(read(f, 'auth.json'));
  await accounts(f);
  fs.writeFileSync(path.join(f.home, 'auth.json'), JSON.stringify(auth('outgoing')));
  await accounts(f);
  await isolatedEditor(t, f);
  return f;
}
const registration = (f) => ({ id: 'fixture-editor', pid: process.pid, home: f.home, name: 'Fixture editor', reloadProtocol: 3 });
test('本机切换黑盒：相同模型换号也先停止真实旧后端，选文件凭据并发送编号重载', async t => {
  const f = await fixture(t);
  const before = await api(f, 'clients', {});
  const old = before.clients.find(c => c.kind === 'ide' && c.shared);
  assert.ok(old && old.confirmed);
  fs.writeFileSync(path.join(f.home, 'config.toml'), '# keep\nmodel="same"\ncli_auth_credentials_store="keyring"\n');
  await api(f, 'accountSwitch', { id: accountId('target'), threadFollow: 'off', source: 'vscode-local' });
  const result = await finish(f);
  assert.equal(result.status, 'done', JSON.stringify({ result, rpc: f.rpc() }));
  assert.equal(result.desktopRequested, false);
  assert.equal(result.configurationApplied, true);
  assert.equal(read(f), 'model = "same"\ncli_auth_credentials_store = "file"\n# keep\n');
  assert.deepEqual(JSON.parse(read(f, 'auth.json')), f.targetAuth);
  await until(async () => api(f, 'clients', {}), s => !s.clients.some(c => c.pid === old.pid), 6000);
  assert.equal(result.editorReload.count, 1);
  assert.equal(result.editorReload.targets[0].id, 'fixture-editor');
  const cmd = (await api(f, 'clientHeartbeat', registration(f))).command;
  assert.equal(cmd.type, 'reload');
  assert.equal(cmd.id, result.editorReload.targets[0].commandId);
  assert.equal(f.rpc().filter(r => /^thread\//.test(r.method)).length, 0);
});
test('本机切换黑盒：准备拒绝保留登录、配置、目录和真实客户端，释放后可重试', async t => {
  const f = await fixture(t, { target: { exp: 1 }, scenario: { methods: { initialize: { result: {} }, 'account/read': { error: { code: 401, message: 'Unauthorized fixture' } } } } });
  const config = read(f), live = read(f, 'auth.json');
  const before = await api(f, 'clients', {});
  const old = before.clients.find(c => c.kind === 'ide' && c.shared);
  await api(f, 'accountSwitch', { id: accountId('target'), threadFollow: 'off' });
  const result = await finish(f);
  assert.equal(result.status, 'error');
  assert.equal(result.configurationApplied, false);
  assert.equal(read(f), config);
  assert.equal(read(f, 'auth.json'), live);
  assert.ok((await api(f, 'clients', {})).clients.some(c => c.pid === old.pid));
  assert.equal(fs.existsSync(path.join(f.bridge, 'model-catalog.json')), false);
  await until(async () => fs.existsSync(path.join(f.bridge, 'operation.lock')), v => !v);
  await api(f, 'providerAdd', { name: 'after failure', baseUrl: 'https://example.test/v1', apiMode: 'responses', apiKey: 'fixture', model: 'm' });
  const events = fs.readFileSync(path.join(f.bridge, 'logs/switcher.log'), 'utf8').trim().split('\n').map(JSON.parse);
  const relevant = events.filter(e => /^switch\./.test(e.event));
  assert.equal(relevant[0].event, 'switch.start');
  assert.ok(relevant.some(e => e.event === 'switch.clients'));
  assert.ok(relevant.some(e => e.event === 'switch.step' && e.id === 'prepare' && e.status === 'error'));
  assert.equal(relevant.at(-1).status, 'error');
});
test('本机切换黑盒：等待并行准备收尾时锁拒绝第二实例修改，准备完成后才应用', async t => {
  const f = await fixture(t, { target: { exp: 1 }, scenario: { methods: { initialize: { result: {} }, 'account/read': { waitFile: 'release-preparation', result: { account: { type: 'chatgpt' } } } } } });
  const config = read(f), live = read(f, 'auth.json');
  await api(f, 'accountSwitch', { id: accountId('target'), threadFollow: 'off' });
  await until(async () => f.rpc(), rows => rows.some(r => r.method === 'account/read' && r.params.refreshToken));
  const blocked = await api(f, 'providerAdd', { name: 'blocked', baseUrl: 'https://example.test/v1', apiMode: 'responses', apiKey: 'fixture', model: 'm' }, 400);
  assert.match(blocked.error, /正在|操作/);
  assert.equal(read(f), config); assert.equal(read(f, 'auth.json'), live);
  assert.equal(job(f).configurationApplied, false);
  fs.writeFileSync(path.join(f.root, 'release-preparation'), 'go');
  const completed = await finish(f); assert.equal(completed.status, 'done', JSON.stringify(completed));
  assert.deepEqual(JSON.parse(read(f, 'auth.json')), auth('target', { exp: 1 }));
});
test('本机切换黑盒：API准备失败保留全文与模型目录，后台记录明确失败', async t => {
  const f = await fixture(t, { scenario: { methods: { initialize: { error: { code: -32000, message: 'fixture validation rejected' } } } } });
  const { id } = await api(f, 'providerAdd', { name: 'API fixture', baseUrl: 'https://example.test/v1', apiMode: 'responses', model: 'm', models: ['m'], apiKey: 'fixture' });
  const store = require('../src/config/providers.cjs'); store.recordProbe(f.bridge, store.list(f.bridge).find(p => p.id === id), 'm', 'direct', 'fixture-direct');
  const config = read(f), live = read(f, 'auth.json');
  const catalog = path.join(f.bridge, 'model-catalog.json'); fs.writeFileSync(catalog, '{"models":[{"slug":"preserve"}]}');
  const originalCatalog = fs.readFileSync(catalog, 'utf8');
  await api(f, 'desktopSwitch', { id, model: 'm', threadFollow: 'off', source: 'vscode-local' });
  const result = await finish(f);
  assert.equal(result.status, 'error'); assert.equal(result.configurationApplied, false);
  assert.equal(read(f), config); assert.equal(read(f, 'auth.json'), live);
  assert.equal(fs.readFileSync(catalog, 'utf8'), originalCatalog);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.bridge, 'account-switch-job.json'))).source, 'vscode-local');
});
test('本机切换黑盒：IDE-only缺少模型和缓存仍换号，没有共享编辑器时不释放或重载', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.home, 'config.toml'), '# no default model\n');
  await api(f, 'accountSwitch', { id: accountId('target'), reloadEditors: false, threadFollow: 'off' });
  const result = await finish(f); assert.equal(result.status, 'done', JSON.stringify(result));
  assert.equal(result.desktopRequested, false); assert.equal(result.editorReload ?? null, null);
  assert.equal(read(f), 'cli_auth_credentials_store = "file"\n# no default model\n');
  assert.equal(toml.parse(read(f)).model, undefined);
  assert.ok((await api(f, 'clients', {})).clients.some(c => c.kind === 'ide' && c.shared));
});
test('旧对话同步黑盒：切换后通过同一官方RPC冷启动核对来源、模型和速度', async t => {
  const f = await fixture(t, { scenario: { methods: {
    initialize: { result: {} },
    'account/read': { result: { account: { type: 'chatgpt' } } },
    'model/list': { result: { data: [{ model: 'new-model', isDefault: true }] } },
    'thread/resume': { result: { modelProvider: 'openai', model: 'new-model', serviceTier: 'priority' } },
    'thread/read': { result: { thread: { modelProvider: 'openai', model: 'new-model', serviceTier: 'priority' } } },
    'thread/unsubscribe': { result: {} },
  } } });
  const { DatabaseSync } = require('node:sqlite');
  const rollout = path.join(f.root, 'thread.jsonl');
  fs.writeFileSync(rollout, JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'priority' } } }) + '\n');
  const db = new DatabaseSync(path.join(f.home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, model_provider TEXT, model TEXT, rollout_path TEXT, archived INTEGER, source TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run('thread-1', 'openai', 'old-model', rollout, 0, '{}');
  db.close();
  fs.writeFileSync(path.join(f.home, 'config.toml'), 'model="new-model"\nmodel_provider="openai"\n');
  await api(f, 'accountSwitch', { id: accountId('target'), threadFollow: 'all', reloadEditors: false });
  const result = await finish(f);
  assert.equal(result.status, 'done', JSON.stringify({ result, rpc: f.rpc() }));
  assert.deepEqual(result.threads, { updated: 1, skipped: 0, failed: 0 });
  assert.equal(read(f), 'model = "new-model"\ncli_auth_credentials_store = "file"\n');
  assert.equal(f.rpc().filter(r => r.method === 'thread/resume').length >= 1, true);
});

test('旧对话失败黑盒：失败保持未完成并恢复编辑器，继续同步不重复应用账号', async t => {
  const f = await fixture(t, { scenario: { methods: {
    initialize: { result: {} },
    'model/list': { result: { data: [{ model: 'blackbox-fixture', isDefault: true }] } },
    'thread/resume': { error: { code: -32000, message: 'active writer fixture' } },
    'thread/read': { result: { thread: { modelProvider: 'openai', model: 'blackbox-fixture' } } },
    'thread/unsubscribe': { result: {} },
  } } });
  const { DatabaseSync } = require('node:sqlite');
  const rollout = path.join(f.root, 'thread.jsonl'); fs.writeFileSync(rollout, '{}\n');
  const db = new DatabaseSync(path.join(f.home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, model_provider TEXT, model TEXT, rollout_path TEXT, archived INTEGER, source TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run('thread-1', 'other', 'old-model', rollout, 0, '{}'); db.close();
  await api(f, 'accountSwitch', { id: accountId('target') });
  const failed = await finish(f); assert.equal(failed.status, 'error'); assert.equal(failed.configurationApplied, true); assert.equal(failed.threads.failed, 1);
  assert.equal(failed.editorReload.count, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.bridge, 'effect.json'))).status, 'switch_incomplete');
  const config = read(f), applied = read(f, 'auth.json');
  f.update(s => { s.methods['thread/resume'] = { result: { modelProvider: 'openai', model: 'blackbox-fixture' } }; });
  await until(async () => fs.existsSync(path.join(f.bridge, 'operation.lock')), v => !v);
  await api(f, 'resumeThreadSync', { source: 'vscode-local' });
  const result = await finish(f); assert.equal(result.status, 'done', JSON.stringify(result));
  assert.equal(result.threads.updated, 1); assert.equal(read(f), config); assert.equal(read(f, 'auth.json'), applied);
});
