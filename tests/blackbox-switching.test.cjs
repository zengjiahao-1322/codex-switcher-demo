'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { startBackend } = require('./backend-process.cjs');
const { api } = require('./config-blackbox-helpers.cjs');
const { auth, accountId, until } = require('./official-blackbox-helpers.cjs');
const provider = {
  id: 'fixture-provider',
  name: 'Remote Fixture',
  baseUrl: 'https://api.example.test/v1',
  apiMode: 'responses',
  apiKey: 'fixture-secret',
  model: 'remote-model',
  models: ['remote-model'],
};
function registration() {
  return {
    id: 'remote-switch-blackbox',
    pid: 800,
    name: 'VS Code',
    workspace: '/srv/project',
    companionVersion: '0.1.3',
    remoteType: 'ssh-remote',
    remoteProtocol: 1,
    authority: 'ssh-remote+fixture',
    remote: 'ssh-remote+fixture',
    remoteAgent: {
      protocol: 3,
      agentVersion: '0.1.3',
      host: 'fixture',
      platform: 'linux',
      arch: 'x64',
      codexHome: '/srv/.codex',
      startedAt: '2026-10-28T00:00:00Z',
      configExists: true,
      current: { model: 'old', modelProvider: 'openai', baseUrl: null },
    },
  };
}
test('双后台切换黑盒：远端独立remoteSwitch通过真实HTTP心跳读写并保留本机文件', async (t) => {
  let providerId;
  const f = await startBackend(t, {
    setup({ bridge }) {
      const store = require('../src/config/providers.cjs');
      providerId = store.add(bridge, provider);
      const saved = store.list(bridge).find((item) => item.id === providerId);
      store.recordProbe(bridge, saved, 'remote-model', 'direct', 'fixture-direct');
    },
  });
  fs.writeFileSync(path.join(f.home, 'config.toml'), 'model="local"\nmodel_provider="openai"\n');
  const localConfig = fs.readFileSync(path.join(f.home, 'config.toml'), 'utf8');
  const input = registration();
  await api(f, 'clientHeartbeat', input);
  const pending = api(f, 'remoteSwitch', {
    authority: input.authority,
    providerId,
    model: 'remote-model',
  });
  let command;
  for (let i = 0; i < 100 && !command; i++) {
    const body = await api(f, 'clientHeartbeat', input);
    command = body.command;
    if (!command) await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(command, 'remote command must be delivered by heartbeat');
  assert.equal(command.step, 'read');
  const remoteConfig = 'model="old"\n';
  const readAck = await api(f, 'clientHeartbeat', {
    ...input,
    ack: command.id,
    ackStatus: 'completed',
    ackResult: {
      text: remoteConfig,
      sha256: require('node:crypto').createHash('sha256').update(remoteConfig).digest('hex'),
    },
  });
  assert.equal(readAck.command, null);
  let write;
  for (let i = 0; i < 100 && !write; i++) {
    const body = await api(f, 'clientHeartbeat', input);
    write = body.command;
    if (!write) await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(write);
  assert.equal(write.step, 'write');
  assert.match(write.text, /remote-model/);
  const expected = write.text;
  const writeAck = await api(f, 'clientHeartbeat', {
    ...input,
    ack: write.id,
    ackStatus: 'completed',
    ackResult: {
      ok: true,
      sha256: require('node:crypto').createHash('sha256').update(expected).digest('hex'),
    },
  });
  assert.equal(writeAck.command, null);
  const result = await pending;
  assert.deepEqual(result, {
    results: [{ codexHome: '/srv/.codex', status: 'synced' }],
  });
  assert.equal(fs.readFileSync(path.join(f.home, 'config.toml'), 'utf8'), localConfig);
});

test('远端登录同步黑盒：SSH心跳按已保存账号读取并合并更新', async (t) => {
  const saved = auth('target', { refreshed: '2026-10-27T00:00:00Z' });
  const remoteAuth = auth('target', { refreshed: '2026-10-28T00:00:00Z' });
  const id = accountId('target');
  const f = await startBackend(t, { setup({ bridge }) {
    fs.mkdirSync(path.join(bridge, 'accounts', id), { recursive: true });
    fs.writeFileSync(path.join(bridge, 'accounts', 'index.json'), JSON.stringify([{ id }]));
    fs.writeFileSync(path.join(bridge, 'accounts', id, 'auth.json'), JSON.stringify(saved));
  }});
  const input = { id: 'remote-sync-window', pid: process.pid, name: 'Remote VS Code', remoteType: 'ssh-remote', remote: 'ssh-remote+fixture', authority: 'ssh-remote+fixture', companionVersion: '0.1.3', remoteProtocol: 1,
    remoteAgent: { protocol: 3, agentVersion: '0.1.3', host: 'fixture', platform: 'linux', arch: 'x64', codexHome: '/srv/.codex', startedAt: '2026-10-28T00:00:00Z', configExists: true,
      account: { id, email: 'target@example.test', plan: 'plus', lastRefresh: remoteAuth.last_refresh }, current: { model: 'old', modelProvider: 'openai', baseUrl: null } } };
  await api(f, 'clientHeartbeat', input);
  const next = async () => (await api(f, 'clientHeartbeat', input)).command;
  let command;
  for (let i = 0; i < 100 && !command; i++) { command = await next(); if (!command) await new Promise(r => setTimeout(r, 20)); }
  assert.ok(command); assert.equal(command.step, 'read');
  const original = 'model="remote"\nmodel_provider="openai"\n';
  const sha = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  await api(f, 'clientHeartbeat', { ...input, ack: command.id, ackStatus: 'completed', ackResult: { text: original, sha256: sha(original) } });
  command = null;
  for (let i = 0; i < 100 && !command; i++) { command = await next(); if (!command) await new Promise(r => setTimeout(r, 20)); }
  assert.ok(command); assert.equal(command.step, 'readAuth');
  const authText = JSON.stringify(remoteAuth);
  await api(f, 'clientHeartbeat', { ...input, ack: command.id, ackStatus: 'completed', ackResult: { text: authText, sha256: sha(authText) } });
  await until(async () => JSON.parse(fs.readFileSync(path.join(f.bridge, 'accounts', id, 'auth.json'))), row => row.last_refresh === remoteAuth.last_refresh, 5000);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.bridge, 'clients', input.id + '.json'))).remoteAgent.account.id, id);
});
