'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const toml = require('smol-toml');
const { startBackend } = require('./backend-process.cjs');
const { api } = require('./config-blackbox-helpers.cjs');
const { auth, accountId, until } = require('./official-blackbox-helpers.cjs');
const version = require('../package.json').version;
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const registration = (id = 'remote-matrix-window') => ({
  id, pid: process.pid, name: 'Remote fixture', remote: 'ssh-remote+fixture', remoteType: 'ssh-remote', authority: 'ssh-remote+fixture', remoteProtocol: 1, companionVersion: version,
  remoteAgent: { protocol: 3, agentVersion: version, host: 'fixture', platform: 'linux', arch: 'x64', codexHome: '/srv/.codex', startedAt: '2026-10-28T00:00:00Z', configExists: true, current: { model: 'old', modelProvider: 'openai', baseUrl: null } },
});
async function fixture(t, setup) {
  let providerId;
  const f = await startBackend(t, { setup(context) {
    const store = require('../src/config/providers.cjs');
    providerId = store.add(context.bridge, { name: 'Remote fixture', apiMode: 'responses', baseUrl: 'https://example.test/v1', apiKey: 'arbitrary-remote-key-PRIVATE', model: 'm', models: ['m'] });
    store.recordProbe(context.bridge, store.list(context.bridge).find(p => p.id === providerId), 'm', 'direct', 'fixture');
    if (setup) setup(context);
  } });
  f.providerId = providerId;
  f.switch = (input, extra = {}) => api(f, 'remoteSwitch', { authority: input.authority, providerId, model: 'm', ...extra });
  return f;
}
async function command(f, input) {
  return (await until(async () => api(f, 'clientHeartbeat', input), body => !!body.command)).command;
}
const ack = (f, input, cmd, result) => api(f, 'clientHeartbeat', { ...input, ack: cmd.id, ackStatus: 'completed', ackResult: result });
const logs = f => fs.readFileSync(path.join(f.bridge, 'logs/switcher.log'), 'utf8').trim().split('\n').map(JSON.parse);
test('远端黑盒：同组只写一次、保留全文设置、另一窗口重载并由新startedAt确认', async t => {
  const f = await fixture(t), first = registration('remote-matrix-aaa'), second = registration('remote-matrix-zzz');
  await api(f, 'clientHeartbeat', first); await api(f, 'clientHeartbeat', second);
  const pending = f.switch(first); const read = await command(f, first);
  const original = 'model="old"\n[projects."/srv/keep"]\ntrust_level="trusted"\n';
  await ack(f, first, read, { text: original, sha256: sha(original) });
  const write = await command(f, first); assert.equal(write.step, 'write'); assert.equal(write.expectedSha256, sha(original));
  assert.equal(write.text, 'model = "m"\nmodel_provider = "hermes_bridge"\n[projects."/srv/keep"]\ntrust_level="trusted"\n[model_providers.hermes_bridge]\nname = "Remote fixture"\nbase_url = "https://example.test/v1"\nwire_api = "responses"\nexperimental_bearer_token = "arbitrary-remote-key-PRIVATE"\nrequires_openai_auth = false\n');
  await ack(f, first, write, { ok: true, sha256: sha(write.text), reload: { method: 'remoteHostExit' } });
  const reload = await command(f, second); assert.equal(reload.type, 'remoteReload');
  await ack(f, second, reload, { reload: { method: 'remoteHostExit' } });
  assert.deepEqual(await pending, { results: [{ codexHome: '/srv/.codex', status: 'synced' }] });
  const restart = { ...second, remoteAgent: { ...second.remoteAgent, startedAt: new Date(Date.now() + 1).toISOString() } };
  assert.equal((await api(f, 'clientHeartbeat', restart)).reloadConfirmed, true);
  assert.equal(logs(f).filter(r => r.event === 'remote.sync' && r.status === 'synced').length, 1);
  assert.ok(logs(f).some(r => r.event === 'remote.reload' && r.status === 'confirmed' && r.method === 'remoteHostExit'));
  const registry = fs.readdirSync(path.join(f.bridge, 'clients')).map(n => fs.readFileSync(path.join(f.bridge, 'clients', n), 'utf8')).join('');
  assert.doesNotMatch(registry, /arbitrary-remote-key|trust_level|expectedSha256/);
});
test('远端黑盒：读回校验失败不写、写入错误隐藏任意密钥和配置正文', async t => {
  const f = await fixture(t), input = registration(); await api(f, 'clientHeartbeat', input);
  let pending = f.switch(input); let cmd = await command(f, input);
  await ack(f, input, cmd, { text: 'model="private"\n', sha256: 'wrong' });
  assert.equal((await pending).results[0].status, 'failed');
  assert.equal((await api(f, 'clientHeartbeat', input)).command, null);
  pending = f.switch(input); cmd = await command(f, input); const original = 'model="PRIVATE_CONFIG"\n';
  await ack(f, input, cmd, { text: original, sha256: sha(original) }); cmd = await command(f, input);
  await api(f, 'clientHeartbeat', { ...input, ack: cmd.id, ackStatus: 'failed', ackError: original + 'arbitrary-remote-key-PRIVATE' });
  const failure = await pending; assert.equal(failure.results[0].status, 'failed');
  assert.doesNotMatch(JSON.stringify(failure) + fs.readFileSync(path.join(f.bridge, 'logs/switcher.log'), 'utf8'), /PRIVATE_CONFIG|arbitrary-remote-key-PRIVATE/);
  assert.equal(fs.existsSync(path.join(f.bridge, 'account-switch.json')), false);
});
test('远端黑盒：缺代理或版本不符跳过、非SSH和未连接服务器明确拒绝', async t => {
  const f = await fixture(t), input = registration();
  await api(f, 'remoteSwitch', { authority: 'wsl+fixture', providerId: f.providerId, model: 'm' }, 400);
  await api(f, 'remoteSwitch', { authority: 'ssh-remote+offline', providerId: f.providerId, model: 'm' }, 400);
  await api(f, 'clientHeartbeat', { ...input, remoteAgent: null });
  assert.equal((await f.switch(input)).results[0].status, 'skipped');
  await api(f, 'clientHeartbeat', { ...input, remoteAgent: { ...input.remoteAgent, agentVersion: '0.0.0' } });
  assert.equal((await f.switch(input)).results[0].status, 'skipped');
  assert.equal(fs.existsSync(path.join(f.bridge, 'account-switch-job.json')), false);
});
test('远端黑盒：官方账号读写auth并拒绝keyring，保持本机配置和登录全文', async t => {
  const selected = auth('selected'); const id = accountId('selected');
  const f = await fixture(t, ({ bridge }) => {
    fs.mkdirSync(path.join(bridge, 'accounts', id), { recursive: true });
    fs.writeFileSync(path.join(bridge, 'accounts', 'index.json'), JSON.stringify([{ id, email: 'selected@example.test' }]));
    fs.writeFileSync(path.join(bridge, 'accounts', id, 'auth.json'), JSON.stringify(selected));
  });
  const input = registration(); await api(f, 'clientHeartbeat', input);
  const before = fs.readFileSync(path.join(f.home, 'config.toml'), 'utf8');
  const options = { authority: input.authority, accountId: id };
  let pending = api(f, 'remoteSwitch', options); let cmd = await command(f, input);
  const original = 'model="old-api"\nmodel_provider="hermes_bridge"\n[model_providers.hermes_bridge]\nname="keep-table"\n';
  await ack(f, input, cmd, { text: original, sha256: sha(original) }); cmd = await command(f, input); assert.equal(cmd.step, 'readAuth');
  await ack(f, input, cmd, { text: '{}', sha256: sha('{}') }); cmd = await command(f, input);
  assert.equal(cmd.text, 'cli_auth_credentials_store = "file"\n[model_providers.hermes_bridge]\nname = "keep-table"\n');
  assert.deepEqual(JSON.parse(cmd.auth.text), selected); assert.equal(cmd.auth.expectedSha256, sha('{}'));
  await ack(f, input, cmd, { ok: true, sha256: sha(cmd.text), authSha256: sha(cmd.auth.text) });
  assert.equal((await pending).results[0].status, 'synced');
  pending = api(f, 'remoteSwitch', options); cmd = await command(f, input); const keyring = 'cli_auth_credentials_store="keyring"\n';
  await ack(f, input, cmd, { text: keyring, sha256: sha(keyring) });
  assert.match((await pending).results[0].reason, /keyring/);
  assert.equal((await api(f, 'clientHeartbeat', input)).command, null);
  assert.equal(fs.readFileSync(path.join(f.home, 'config.toml'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.home, 'auth.json')), false);
});
function unzip(bytes) {
  const files = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8), size = bytes.readUInt32LE(offset + 18), names = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + names).toString(); const start = offset + 30 + names + extra;
    const payload = bytes.subarray(start, start + size); files.set(name, method === 8 ? require('node:zlib').inflateRawSync(payload) : payload); offset = start + size;
  } return files;
}
test('扩展黑盒：两种VSIX下载内容与JS源码一致，远端安装走内存命令并确认激活版本', async t => {
  const f = await fixture(t);
  for (const [action, dir, filename] of [['companionPackage', 'vscode-companion', 'codex-switcher-companion.vsix'], ['remoteAgentPackage', 'vscode-remote-agent', 'codex-switcher-remote.vsix']]) {
    const download = await api(f, action, {}); assert.equal(download.filename, filename);
    const response = await f.request(download.url); assert.equal(response.status, 200);
    const files = unzip(Buffer.from(await response.arrayBuffer()));
    for (const name of ['package.json', 'extension.cjs']) assert.deepEqual(files.get('extension/' + name), fs.readFileSync(path.join(__dirname, '..', dir, name)));
    assert.ok(files.get('extension.vsixmanifest').includes(Buffer.from(version)));
    assert.equal((await f.request(download.url)).status, 404);
  }
  const input = registration(); await api(f, 'clientHeartbeat', input);
  const pending = api(f, 'installRemoteAgent', { id: input.id }); const cmd = await command(f, input);
  assert.equal(cmd.type, 'installRemoteAgent'); assert.ok(unzip(Buffer.from(cmd.base64, 'base64')).has('extension/extension.cjs'));
  await ack(f, input, cmd, { installed: true, reload: { method: 'remoteHostExit' } }); await pending;
  const next = { ...input, remoteAgent: { ...input.remoteAgent, startedAt: new Date(Date.now() + 1).toISOString() } };
  assert.equal((await api(f, 'clientHeartbeat', next)).reloadConfirmed, true);
  assert.ok(logs(f).some(e => e.event === 'remote.install' && e.status === 'active'));
  assert.doesNotMatch(fs.readFileSync(path.join(f.bridge, 'clients', input.id + '.json'), 'utf8'), /base64|UEsDB/);
});
