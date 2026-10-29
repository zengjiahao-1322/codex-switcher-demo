'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { startBackend } = require('./backend-process.cjs');
const { api, isolatedEditor } = require('./config-blackbox-helpers.cjs');
const { until } = require('./official-blackbox-helpers.cjs');
const { isRust } = require('./backend.cjs');
test('窗口黑盒：真实父子PID关联、独立目录隔离、对应重载编号和失败回报', async (t) => {
  const f = await startBackend(t);
  await isolatedEditor(t, f);
  const registration = {
    id: 'fixture-editor',
    pid: process.pid,
    home: f.home,
    name: 'Fixture editor',
    reloadProtocol: 3,
  };
  const linked = await api(f, 'clientHeartbeat', registration);
  assert.equal(linked.connection.state, 'ready');
  assert.ok(linked.connection.backendPids.length > 0);
  const stateLog = fs
    .readFileSync(path.join(f.bridge, 'logs/switcher.log'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
    .find((row) => row.event === 'companion.state');
  assert.equal(stateLog.to, 'ready');
  assert.equal(stateLog.editor, registration.id);
  const status = await api(f, 'clients', {});
  const editor = status.clients.find((c) => c.editorId === registration.id && c.kind === 'editor');
  assert.equal(editor.canReload, true);
  const reload = await api(f, 'reloadClients', { id: registration.id });
  assert.equal(reload.count, 1);
  assert.equal(reload.targets[0].id, registration.id);
  const command = (await api(f, 'clientHeartbeat', registration)).command;
  assert.equal(command.type, 'reload');
  assert.equal(
    (
      await api(f, 'clientHeartbeat', {
        ...registration,
        ack: 'wrong-command',
        ackStatus: 'reload_requested',
      })
    ).command.id,
    command.id,
  );
  assert.equal(
    (
      await api(f, 'clientHeartbeat', {
        ...registration,
        ack: command.id,
        ackStatus: 'reload_requested',
      })
    ).command,
    null,
  );
  const file = path.join(f.bridge, 'clients', registration.id + '.json');
  assert.equal(JSON.parse(fs.readFileSync(file)).lastAck.status, 'reload_requested');
  const fresh = {
    ...registration,
    id: 'fixture-reloaded',
    completedReload: { clientId: registration.id, commandId: command.id },
  };
  const old = JSON.parse(fs.readFileSync(file));
  old.pid = 987654321;
  fs.writeFileSync(file, JSON.stringify(old));
  assert.equal((await api(f, 'clientHeartbeat', fresh)).reloadConfirmed, true);
  const failure = await api(f, 'reloadClients', { id: fresh.id });
  const failureId = failure.targets[0].commandId;
  await api(f, 'clientHeartbeat', {
    ...fresh,
    completedReload: undefined,
    ack: failureId,
    ackStatus: 'reload_failed',
    ackError: 'fixture failed',
  });
  const row = JSON.parse(fs.readFileSync(path.join(f.bridge, 'clients', fresh.id + '.json')));
  assert.equal(row.lastAck.status, 'reload_failed');
  assert.equal(row.lastAck.error, 'fixture failed');
  const separate = await api(f, 'clientHeartbeat', {
    id: 'independent-window',
    pid: 987654321,
    home: path.join(f.root, 'other'),
    name: 'Independent',
  });
  assert.equal(separate.connection.state, 'unmatched');
  await api(f, 'reloadClients', { id: 'independent-window' }, 400);
});
test('长轮询黑盒：超过15秒租期有效、外部写命令唤醒、断开一窗不影响另一窗', async (t) => {
  const f = await startBackend(t);
  const beat = (id, wait = 0, signal) =>
    f.request('/api/clientHeartbeat', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        pid: process.pid,
        remote: 'ssh-remote+fixture',
        companionHost: 'local',
        wait,
      }),
      signal,
    });
  for (const id of ['waiting-window-one', 'waiting-window-two'])
    assert.equal((await beat(id)).status, 200);
  const controller = new AbortController();
  const one = beat('waiting-window-one', 25000, controller.signal).catch((e) => e);
  const two = beat('waiting-window-two', 25000);
  two.catch(() => {});
  const timeoutStarted = performance.now();
  const natural = beat('waiting-window-timeout', 25000);
  await new Promise((r) => setTimeout(r, 16000));
  const file = (id) => path.join(f.bridge, 'clients', id + '.json');
  let row = JSON.parse(fs.readFileSync(file('waiting-window-two')));
  assert.ok(row.waitUntil > Date.now());
  controller.abort();
  await one;
  const started = performance.now();
  row.command = { id: 'surviving-command', type: 'reload' };
  require('../src/accounts/accounts.cjs').writeJson(file('waiting-window-two'), row);
  const returned = await (await two).json();
  assert.equal(returned.command.id, 'surviving-command');
  const wakeElapsed = performance.now() - started;
  t.diagnostic('External command wake-up: ' + wakeElapsed + ' ms');
  assert.ok(wakeElapsed < 500, 'External command wake-up: ' + wakeElapsed + ' ms');
  await until(
    async () => JSON.parse(fs.readFileSync(file('waiting-window-two'))),
    (r) => r.waitUntil === undefined,
  );
  await until(
    async () => JSON.parse(fs.readFileSync(file('waiting-window-one'))),
    (r) => r.waitUntil === undefined,
  );
  const empty = await (await natural).json();
  const elapsed = performance.now() - timeoutStarted;
  assert.equal(empty.command, null);
  assert.ok(elapsed >= 24500 && elapsed < 27000, 'Natural long-poll deadline: ' + elapsed);
  assert.equal(JSON.parse(fs.readFileSync(file('waiting-window-timeout'))).waitUntil, undefined);
});
test('心跳黑盒：非可信程序路径不入库，SSH公开字段去除正文密钥和URL查询', async (t) => {
  const f = await startBackend(t);
  const id = 'metadata-only-window';
  const input = {
    id,
    pid: process.pid,
    remote: 'ssh-remote+fixture',
    remoteType: 'ssh-remote',
    authority: 'ssh-remote+fixture',
    companionVersion: '0.1.3',
    extensionPath: f.root,
    codexExe: path.join(f.root, 'untrusted.exe'),
    remoteAgent: {
      protocol: 3,
      agentVersion: '0.1.3',
      host: 'fixture',
      platform: 'linux',
      arch: 'x64',
      codexHome: '/srv/.codex',
      configExists: true,
      text: 'PRIVATE_CONFIG',
      apiKey: 'PRIVATE_KEY',
      current: {
        model: 'm',
        modelProvider: 'openai',
        baseUrl: 'https://user:password@example.test/v1?token=PRIVATE_URL',
        apiKey: 'PRIVATE_KEY',
      },
    },
  };
  for (let i = 0; i < 10; i++) await api(f, 'clientHeartbeat', input);
  const saved = fs.readFileSync(path.join(f.bridge, 'clients', id + '.json'), 'utf8');
  assert.doesNotMatch(saved, /PRIVATE|password|untrusted.exe/);
  assert.equal(JSON.parse(saved).codexExe, null);
  assert.equal(JSON.parse(saved).extensionPath, null);
  const clients = await api(f, 'clients', {});
  assert.equal(clients.remotes.length, 1);
  assert.equal(clients.remotes[0].current.baseUrl, 'https://example.test/v1');
  const logs = fs
    .readFileSync(path.join(f.bridge, 'logs/switcher.log'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(logs.filter((e) => e.event === 'remote.agent').length, 1);
  await api(f, 'clientHeartbeat', { ...input, id: '../../escape' }, 400);
  if (isRust) {
    const denied = await f.request('/api/clientHeartbeat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer private-rejected-bearer',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    assert.equal(denied.status, 401);
    const malformed = await f.request('/api/clientHeartbeat', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json' },
      body: '{"companionVersion":"0.1.3",broken',
    });
    assert.equal(malformed.status, 400);
    const text = fs.readFileSync(path.join(f.bridge, 'logs/switcher.log'), 'utf8');
    const rejected = text
      .trim()
      .split('\n')
      .map(JSON.parse)
      .filter((row) => row.event === 'companion.reject');
    assert.equal(rejected.length, 3);
    assert.match(rejected[0].reason, /400.*客户端编号/);
    assert.equal(rejected[0].companionVersion, '0.1.3');
    assert.match(rejected[1].reason, /401/);
    assert.equal(rejected[1].companionVersion, '0.1.3');
    assert.match(rejected[2].reason, /Invalid JSON/);
    assert.equal(rejected[2].companionVersion, null);
    assert.doesNotMatch(text, /private-rejected-bearer/);
  }
});
