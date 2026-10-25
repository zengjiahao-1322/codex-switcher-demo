'use strict';

const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  cp = require('node:child_process'),
  backups = require('../src/config/backups.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-backups-')),
    codexHome = path.join(root, 'codex'),
    bridgeHome = path.join(root, 'bridge');
  fs.mkdirSync(codexHome);
  fs.mkdirSync(bridgeHome);
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  // 只替换外部运行程序和任务启动；配置、备份、切换任务与日志都实际写入隔离目录。
  t.mock.method(require('../src/platform/runtime.cjs'), 'findCodex', () => process.execPath);
  t.mock.method(require('../src/platform/compatibility.cjs'), 'validateConfig', async () => ({
    ok: true,
  }));
  t.mock.method(require('../src/clients/client-status.cjs'), 'clientStatus', () => ({
    clients: [{ kind: 'editor', confirmed: true, shared: true }],
  }));
  t.mock.method(cp, 'spawn', () => ({ pid: process.pid, unref() {}, send() {} }));
  const service = require('../src/server/service.cjs').createService({ codexHome, bridgeHome });
  return { codexHome, bridgeHome, service };
}

test('配置副本去重并保留十份，恢复走切换任务且先保存当前配置，登录文件保持原样', async (t) => {
  const f = fixture(t),
    config = path.join(f.codexHome, 'config.toml'),
    auth = path.join(f.codexHome, 'auth.json'),
    login = '{"fixture":"unchanged-login"}\n';
  fs.writeFileSync(auth, login);
  for (let i = 0; i < 12; i++) {
    fs.writeFileSync(config, 'model="before-' + i + '"\n');
    backups.save(f.codexHome, f.bridgeHome, 'switch');
    backups.save(f.codexHome, f.bridgeHome, 'switch');
  }
  const items = f.service.actions.backups({}).items,
    oldest = items.at(-1);
  assert.equal(items.length, 10);
  assert.equal(items[0].summary, '官方 · before-11');
  assert.equal(oldest.summary, '官方 · before-2');
  fs.writeFileSync(config, 'model="current-unsaved"\n');
  await f.service.actions.restoreBackup({
    id: oldest.id,
    reloadEditors: false,
    source: 'vscode-local',
  });
  const job = JSON.parse(fs.readFileSync(path.join(f.bridgeHome, 'account-switch-job.json')));
  await require('../src/clients/desktop-account.cjs').runSwitch(job, {
    stop: () => assert.fail('隔离恢复不能关闭桌面应用'),
    open: () => assert.fail('隔离恢复不能打开桌面应用'),
    accounts: { syncCurrent: () => assert.fail('恢复配置不应同步或切换登录') },
    syncThreads: async () => ({ updated: 0, skipped: 0, failed: 0 }),
  });
  assert.equal(fs.readFileSync(config, 'utf8'), 'model="before-2"\n');
  assert.equal(fs.readFileSync(auth, 'utf8'), login);
  const after = backups.list(f.bridgeHome);
  assert.equal(after.length, 10);
  assert.equal(after[0].reason, 'restore');
  assert.equal(after[0].summary, '官方 · current-unsaved');
  assert.equal(
    fs
      .readdirSync(path.join(f.bridgeHome, 'backups', 'codex-config'))
      .some((name) => name.includes('auth')),
    false,
  );
  const events = require('../src/diagnostics/event-log.cjs').readRecent(f.bridgeHome, 100);
  assert.equal(events.find((row) => row.event === 'config.restore').status, 'restored');
  assert.ok(
    events
      .filter((row) => row.event.startsWith('switch.'))
      .every((row) => row.source === 'vscode-local'),
  );
  await assert.rejects(f.service.actions.restoreBackup({ id: '../auth.json' }), /备份不存在/);
});

test('切换请求的来源进入后台任务，外部输入只能使用约定的来源', async (t) => {
  const f = fixture(t),
    id = require('../src/config/providers.cjs').add(f.bridgeHome, {
      name: 'Fixture API',
      baseUrl: 'https://api.example.test/v1',
      apiMode: 'responses',
      apiKey: 'fixture-key',
      model: 'fixture-model',
    });
  await assert.rejects(
    f.service.actions.desktopSwitch({ id, source: 'unrecognized' }),
    /切换来源无效/,
  );
  await assert.rejects(f.service.actions.remoteSwitch({ source: 'unrecognized' }), /切换来源无效/);
  await f.service.actions.desktopSwitch({ id, source: 'vscode-local' });
  const queued = JSON.parse(fs.readFileSync(path.join(f.bridgeHome, 'account-switch-job.json')));
  assert.equal(queued.source, 'vscode-local');
});
