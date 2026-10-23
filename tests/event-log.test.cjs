'use strict';

const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { log, redact, readRecent } = require('../src/diagnostics/event-log.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-event-log-')),
    codexHome = path.join(root, 'codex'),
    bridgeHome = path.join(root, 'bridge');
  fs.mkdirSync(codexHome);
  fs.mkdirSync(bridgeHome);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model="fixture"\n');
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, codexHome, bridgeHome };
}

test('诊断脱敏返回副本，覆盖嵌套秘密、Bearer 正文和两种用户路径分隔符', () => {
  const original = {
    nested: [{ id_token: 'private-id', password: 'private-password', cookie: 'private-cookie' }],
    message: 'Bearer private-bearer sk-private-key eyJhbGciOiJIUzI1NiJ9.e30.signature',
    url: 'https://example.test/cb?code=private-code&state=private-state&token=private-token',
    account: 'alice@example.test',
    home: os.homedir(),
    file: os.homedir().replace(/\\/g, '/') + '/.codex',
  };
  const before = JSON.stringify(original),
    result = redact(original),
    text = JSON.stringify(result);
  assert.equal(JSON.stringify(original), before);
  assert.notEqual(result, original);
  assert.equal(result.account, 'al***@example.test');
  assert.equal(result.home, '~');
  assert.equal(result.file, '~/.codex');
  assert.doesNotMatch(text, /private-|eyJhbG|alice/);
  assert.equal(result.nested[0].id_token, '[已隐藏]');
});

test('诊断轮换删除最旧文件，跨三份日志保留顺序和最近行数', (t) => {
  const { bridgeHome } = fixture(t),
    padding = 'x'.repeat(2 * 1024 * 1024);
  // 每次越过轮换阈值，下一条写入时才轮换；单条大小不被静默截断。
  for (let i = 0; i < 4; i++) log(bridgeHome, 'switch.step', { index: i, padding });
  log(bridgeHome, 'switch.end', { index: 4 });
  const dir = path.join(bridgeHome, 'logs');
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    'switcher.log',
    'switcher.log.1',
    'switcher.log.2',
  ]);
  assert.deepEqual(
    readRecent(bridgeHome, 10).map((row) => row.index),
    [2, 3, 4],
  );
  assert.deepEqual(
    readRecent(bridgeHome, 2).map((row) => row.index),
    [3, 4],
  );
  for (const name of fs.readdirSync(dir))
    assert.ok(fs.statSync(path.join(dir, name)).size <= 2 * 1024 * 1024 + 16 * 1024);
});

test('同一窗口十次相同心跳只记一次，关联状态改变后才追加', async (t) => {
  const { codexHome, bridgeHome, root } = fixture(t),
    clients = require('../src/clients/client-status.cjs'),
    inventory = {
      ancestry: [{ pid: 710, parentPid: 1, name: 'Code.exe' }],
      processes: [],
    };
  t.mock.method(clients, 'scanAsync', async () => inventory);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const service = require('../src/server/service.cjs').createService({ codexHome, bridgeHome }),
    input = { id: 'fixture-editor', pid: 710, companionVersion: '0.1.3' };
  for (let i = 0; i < 10; i++) await service.actions.clientHeartbeat(input);
  let events = readRecent(bridgeHome, 100);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'companion.state');
  assert.equal(events[0].pid, process.pid);
  assert.equal(events[0].editorPid, 710);
  assert.equal(events[0].from, null);
  assert.equal(events[0].to, 'unmatched');
  inventory.processes.push({
    pid: 711,
    parentPid: 710,
    exe: path.join(root, 'openai.chatgpt-test', 'bin', 'codex.exe'),
    context: { ok: true, home: codexHome },
  });
  now += 5000;
  for (let i = 0; i < 10; i++) await service.actions.clientHeartbeat(input);
  events = readRecent(bridgeHome, 100);
  assert.equal(events.length, 2);
  assert.equal(events[1].from, 'unmatched');
  assert.equal(events[1].to, 'ready');
  assert.deepEqual(events[1].backendPids, [711]);
  inventory.processes[0].context.home = path.join(root, 'independent');
  now += 30000;
  await service.actions.clientHeartbeat(input);
  assert.equal(readRecent(bridgeHome, 1)[0].to, 'separate');
});

test('官方准备、额度和登录失败各自落盘，保留类型与错误码且不泄露秘密', async (t) => {
  const { codexHome, bridgeHome } = fixture(t),
    jwt = (payload) =>
      'eyJhbGciOiJub25lIn0.' +
      Buffer.from(JSON.stringify(payload)).toString('base64url') +
      '.fixture',
    auth = {
      tokens: {
        account_id: 'fixture-account',
        access_token: jwt({ exp: 1, sub: 'fixture-user' }),
        id_token: jwt({ email: 'alice@example.test' }),
        refresh_token: 'private-refresh',
      },
    };
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify(auth));
  const accounts = require('../src/accounts/accounts.cjs').createAccounts({
    codexHome,
    bridgeHome,
    codexExe: () => {
      throw Object.assign(Error('missing runtime sk-private-secret'), { code: 'CODEX_NOT_FOUND' });
    },
  });
  const id = accounts.status().items[0].id;
  await assert.rejects(accounts.prepare(id), /校验程序不可用/);
  assert.equal((await accounts.quota(id)).status, 'error');
  await assert.rejects(accounts.startLogin({ id }), /missing runtime/);
  const events = readRecent(bridgeHome, 10);
  assert.deepEqual(
    events.map((e) => e.op),
    ['prepare', 'quota', 'login'],
  );
  for (const event of events) {
    assert.equal(event.event, 'official.error');
    assert.equal(event.account, 'al***@example.test');
    assert.equal(event.code, 'CODEX_NOT_FOUND');
    assert.equal(event.kind, 'runtime_error');
  }
  const text = fs.readFileSync(path.join(bridgeHome, 'logs', 'switcher.log'), 'utf8');
  assert.doesNotMatch(text, /sk-private-secret|alice|private-refresh/);
  assert.equal(text.includes(auth.tokens.access_token), false);
});
