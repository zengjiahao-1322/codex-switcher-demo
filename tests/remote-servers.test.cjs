'use strict';

const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto'),
  toml = require('smol-toml');
const remote = require('../src/clients/remote-servers.cjs'),
  clients = require('../src/clients/client-status.cjs'),
  { writeJson } = require('../src/accounts/accounts.cjs');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const secret = 'plain-remote-api-fixture-key';
const source = {
  mode: 'direct',
  provider: { name: 'Remote fixture', baseUrl: 'https://api.example.test/v1', apiKey: secret },
  model: 'fixture-new-model',
  catalog: '{"models":[]}',
};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-remote-backend-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function registration(id, extra = {}) {
  return {
    id,
    pid: 800,
    name: 'VS Code',
    workspace: '/srv/project',
    companionVersion: '0.1.3',
    remoteType: 'ssh-remote',
    remoteProtocol: 1,
    authority: 'ssh-remote+fixture-server',
    remote: 'ssh-remote+fixture-server',
    remoteAgent: {
      protocol: 2,
      agentVersion: '0.1.3',
      host: 'fixture-server',
      platform: 'linux',
      arch: 'x64',
      codexHome: '/home/tester/.codex',
      configExists: true,
      current: { model: 'old', modelProvider: 'openai', baseUrl: null },
    },
    ...extra,
  };
}
async function nextCommand(home, id) {
  const until = Date.now() + 1500;
  while (Date.now() < until) {
    const command = remote.command(home, id);
    if (command) return command;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error('没有收到远端命令');
}
const ack = (home, input, command, result) =>
  clients.heartbeat(home, {
    ...input,
    ack: command.id,
    ackStatus: 'completed',
    ackResult: result,
  });
const fileText = (home) =>
  fs
    .readdirSync(home, { recursive: true })
    .filter((name) => fs.statSync(path.join(home, name)).isFile())
    .map((name) => fs.readFileSync(path.join(home, name), 'utf8'))
    .join('\n');

test('远端列表只保留公开状态，按authority与目录分组，不产生跟随设置', (t) => {
  const home = fixture(t),
    input = registration('remote-settings-window');
  input.remoteAgent.text = 'private-config-content';
  input.remoteAgent.current.apiKey = secret;
  clients.heartbeat(home, input);
  writeJson(path.join(home, 'settings.json'), { codexHome: 'keep-existing-home' });
  assert.equal(remote.groups(home)[0].windows[0].companionVersion, '0.1.3');
  assert.equal('enabled' in remote.groups(home)[0], false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(home, 'settings.json'))).codexHome,
    'keep-existing-home',
  );
  assert.equal(fileText(home).includes(secret), false);
  assert.equal(fileText(home).includes('private-config-content'), false);
});

test('内存命令唤醒长轮询，配置正文、任意形状密钥和ackResult不落客户端文件', async (t) => {
  const home = fixture(t),
    input = registration('remote-memory-window');
  clients.heartbeat(home, input);
  const polling = clients.waitForCommand(home, input.id, 1000, t.signal),
    pending = remote.dispatch(home, input.id, {
      type: 'remoteApply',
      step: 'write',
      text: 'remote-private-body:' + secret,
      reload: true,
    });
  const command = await polling;
  assert.equal(command.text, 'remote-private-body:' + secret);
  assert.equal(fileText(home).includes(secret), false);
  ack(home, input, command, { ok: true, sha256: 'fixture-sha', text: 'private-ack-body' });
  assert.equal((await pending).ok, true);
  assert.equal(remote.command(home, input.id), null);
  assert.equal(fileText(home).includes('private-ack-body'), false);
  assert.equal(fileText(home).includes(secret), false);
  const row = clients.records(home)[0];
  assert.equal(row.lastAck.status, 'reload_requested');
  const completedReload = { clientId: input.id, commandId: command.id };
  const mismatched = clients.heartbeat(home, {
    ...registration('remote-new-host-window', { authority: 'ssh-remote+another-server' }),
    completedReload,
  });
  assert.equal(mismatched.reloadConfirmed, false);
  const completed = clients.heartbeat(home, {
    ...registration('remote-reloaded-window'),
    completedReload,
  });
  assert.equal(completed.reloadConfirmed, true);
  assert.equal(
    clients.heartbeat(home, { ...registration('remote-reloaded-window'), completedReload })
      .reloadConfirmed,
    true,
    '确认回复丢失后，重复确认应返回相同结果',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(home, 'clients', input.id + '.json'))).lastAck.status,
    'reloaded',
  );
  assert.equal(
    clients.records(home).some((item) => item.id === input.id),
    false,
  );
});

test('同服务器同目录只写一次，保留远端设置并使用远端模型路径，同组其他窗口重载', async (t) => {
  const home = fixture(t),
    first = registration('remote-group-first'),
    second = registration('remote-group-second');
  clients.heartbeat(home, first);
  clients.heartbeat(home, second);
  const original = 'model="old"\n[projects."/srv/keep"]\ntrust_level="trusted"\n',
    pending = remote.apply(home, first.authority, source),
    read = await nextCommand(home, first.id);
  assert.equal(read.step, 'read');
  ack(home, first, read, { text: original, sha256: sha(original) });
  const write = await nextCommand(home, first.id),
    parsed = toml.parse(write.text);
  assert.equal(write.step, 'write');
  assert.equal(write.expectedSha256, sha(original));
  assert.equal(write.catalog, source.catalog);
  assert.equal(parsed.model, source.model);
  assert.equal(parsed.model_providers.hermes_bridge.experimental_bearer_token, secret);
  assert.equal(parsed.model_catalog_json, '/home/tester/.codex/switcher-model-catalog.json');
  assert.equal(parsed.projects['/srv/keep'].trust_level, 'trusted');
  ack(home, first, write, { ok: true, sha256: sha(write.text) });
  const result = await pending;
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'synced');
  assert.equal(remote.command(home, second.id), null);
  assert.equal(clients.records(home).find((item) => item.id === second.id).command.type, 'reload');
  assert.equal(fileText(home).includes(secret), false);
  assert.equal(fileText(home).includes('trust_level'), false);
  const events = require('../src/diagnostics/event-log.cjs').readRecent(home, 10);
  assert.deepEqual(
    events.map((row) => row.event),
    ['remote.sync'],
  );
  assert.equal(events[0].sha256.length, 8);
});

test('未装代理和版本不同均跳过，非SSH与未连接服务器明确拒绝', async (t) => {
  const home = fixture(t),
    input = registration('remote-skipping-window');
  clients.heartbeat(home, input);
  await assert.rejects(remote.apply(home, 'wsl+fixture', source), /Remote-SSH/);
  await assert.rejects(remote.apply(home, 'ssh-remote+offline', source), /没有已连接/);
  clients.heartbeat(home, { ...input, remoteAgent: null });
  assert.match((await remote.apply(home, input.authority, source))[0].reason, /尚未接入/);
  clients.heartbeat(home, { ...input, companionVersion: '0.1.4' });
  assert.match((await remote.apply(home, input.authority, source))[0].reason, /请更新远端代理/);
  assert.equal(remote.command(home, input.id), null);
});

test('读回sha不符不写入；写入失败只记录脱敏原因，不影响其他本机设置', async (t) => {
  const home = fixture(t),
    input = registration('remote-failure-window');
  clients.heartbeat(home, input);
  let pending = remote.apply(home, input.authority, source),
    command = await nextCommand(home, input.id);
  ack(home, input, command, { text: 'bad-read', sha256: sha('different') });
  assert.match((await pending)[0].reason, /校验值无效/);
  assert.equal(remote.command(home, input.id), null);
  pending = remote.apply(home, input.authority, source);
  command = await nextCommand(home, input.id);
  ack(home, input, command, { text: '', sha256: sha('') });
  command = await nextCommand(home, input.id);
  clients.heartbeat(home, {
    ...input,
    ack: command.id,
    ackStatus: 'failed',
    ackError: '服务器文件已被手动修改 ' + secret,
  });
  const [result] = await pending;
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /文件已被手动修改/);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(fileText(home).includes(secret), false);
  const events = require('../src/diagnostics/event-log.cjs').readRecent(home, 10);
  assert.equal(events.at(-1).step, 'write');
  assert.equal(events.at(-1).codexHome, input.remoteAgent.codexHome);
  assert.match(events.at(-1).reason, /文件已被手动修改/);
  assert.equal(events.at(-1).reason.includes(secret), false);
});

test('远程请求超时后释放内存命令，不重试也不写磁盘', async (t) => {
  const home = fixture(t),
    input = registration('remote-timeout-window');
  clients.heartbeat(home, input);
  await assert.rejects(
    remote.dispatch(home, input.id, { type: 'remoteApply', step: 'read' }, { timeout: 15 }),
    /超时/,
  );
  assert.equal(remote.command(home, input.id), null);
  assert.equal(clients.records(home)[0].command, null);
});

test('HTTP心跳接受超过16KiB的远端read回执，其他动作请求上限不变', async (t) => {
  const home = fixture(t),
    codexHome = path.join(home, 'codex');
  fs.mkdirSync(codexHome);
  t.mock.method(clients, 'scanAsync', async () => ({ processes: [], ancestry: [] }));
  const service = require('../src/server/service.cjs').createService({
      codexHome,
      bridgeHome: home,
    }),
    server = require('../src/server/server.cjs').createServer({
      token: 'remote-http-fixture',
      actions: { ...service.actions, echo: (input) => input },
    });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const input = registration('remote-http-window'),
    post = (name, body) =>
      fetch('http://127.0.0.1:' + server.address().port + '/api/' + name, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer remote-http-fixture',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
  assert.equal((await post('clientHeartbeat', input)).status, 200);
  const pending = remote.dispatch(home, input.id, { type: 'remoteApply', step: 'read' }),
    command = remote.command(home, input.id),
    text = '# remote config\n'.repeat(2000);
  assert.equal(
    (
      await post('clientHeartbeat', {
        ...input,
        ack: command.id,
        ackStatus: 'completed',
        ackResult: { text, sha256: sha(text) },
      })
    ).status,
    200,
  );
  assert.equal((await pending).text, text);
  assert.equal((await post('echo', { text })).status, 413);
  assert.equal(fileText(home).includes('# remote config'), false);
});

test('独立remoteSwitch经真实HTTP应用所选API，拒绝官方和转换，不修改本机配置与切换任务', async (t) => {
  const home = fixture(t),
    codexHome = path.join(home, 'codex'),
    serverHome = path.join(home, 'remote-files');
  fs.mkdirSync(codexHome);
  fs.mkdirSync(serverHome);
  const localConfig = 'model="local-keep"\nmodel_provider="openai"\n',
    localAuth = '{"fixture":"local-auth-keep"}',
    localJob = '{"status":"done","message":"local-job-keep"}';
  fs.writeFileSync(path.join(codexHome, 'config.toml'), localConfig);
  fs.writeFileSync(path.join(codexHome, 'auth.json'), localAuth);
  fs.writeFileSync(path.join(home, 'account-switch.json'), localJob);
  fs.writeFileSync(
    path.join(codexHome, 'models_cache.json'),
    JSON.stringify({ models: [{ slug: 'base-template', visibility: 'list' }] }),
  );
  const store = require('../src/config/providers.cjs'),
    providerId = store.add(home, {
      ...source.provider,
      apiMode: 'responses',
      model: source.model,
      models: [source.model, 'second-model'],
    }),
    p = store.list(home)[0];
  store.recordProbe(home, p, p.model, 'direct', 'fixture-direct');
  t.mock.method(clients, 'scanAsync', async () => ({ ancestry: [], processes: [] }));
  const service = require('../src/server/service.cjs').createService({
      codexHome,
      bridgeHome: home,
    }),
    server = require('../src/server/server.cjs').createServer({
      token: 'remote-switch-fixture',
      actions: service.actions,
    });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const post = (name, body) =>
      fetch('http://127.0.0.1:' + server.address().port + '/api/' + name, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer remote-switch-fixture',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    agent = require('../vscode-remote-agent/extension.cjs').createAgent({
      home: serverHome,
      version: '0.1.3',
    }),
    input = registration('remote-real-http-window');
  const original = 'model="remote-old"\n[projects."/srv/keep"]\ntrust_level="trusted"\n';
  fs.writeFileSync(path.join(serverHome, 'config.toml'), original);
  assert.equal((await post('clientHeartbeat', input)).status, 200);
  const request = { authority: input.authority, providerId, model: 'selected-remote-model' },
    pending = post('remoteSwitch', request),
    read = await nextCommand(home, input.id);
  assert.equal(
    (
      await post('clientHeartbeat', {
        ...input,
        ack: read.id,
        ackStatus: 'completed',
        ackResult: agent.read(),
      })
    ).status,
    200,
  );
  const write = await nextCommand(home, input.id),
    result = agent.write({
      text: write.text,
      expectedSha256: write.expectedSha256,
      catalog: write.catalog,
    });
  assert.equal(
    (
      await post('clientHeartbeat', {
        ...input,
        ack: write.id,
        ackStatus: 'completed',
        ackResult: result,
      })
    ).status,
    200,
  );
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    results: [{ codexHome: input.remoteAgent.codexHome, status: 'synced' }],
  });
  const parsed = toml.parse(fs.readFileSync(path.join(serverHome, 'config.toml'), 'utf8'));
  assert.equal(parsed.model, request.model);
  assert.equal(parsed.model_catalog_json, '/home/tester/.codex/switcher-model-catalog.json');
  assert.equal(parsed.model_providers.hermes_bridge.experimental_bearer_token, secret);
  assert.equal(
    fs.readFileSync(path.join(serverHome, 'config.toml.switcher-backup'), 'utf8'),
    original,
  );
  const catalog = JSON.parse(
    fs.readFileSync(path.join(serverHome, 'switcher-model-catalog.json'), 'utf8'),
  );
  assert.equal(catalog.models[0].slug, request.model);
  assert.equal((await post('remoteSwitch', { ...request, providerId: 'official' })).status, 400);
  store.recordProbe(home, p, p.model, 'adapter', 'fixture-adapter');
  assert.equal((await post('remoteSwitch', request)).status, 400);
  store.recordProbe(home, p, p.model, 'direct', 'fixture-direct');
  await assert.rejects(service.actions.remoteSwitch({ ...request, model: '' }), /模型/);
  const savedProviders = JSON.parse(fs.readFileSync(path.join(home, 'providers.json')));
  savedProviders.providers[0].apiKey = '';
  writeJson(path.join(home, 'providers.json'), savedProviders);
  store.recordProbe(home, store.list(home)[0], p.model, 'direct', 'fixture-direct-without-key');
  await assert.rejects(service.actions.remoteSwitch(request), /密钥/);
  assert.equal(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), localConfig);
  assert.equal(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'), localAuth);
  assert.equal(fs.readFileSync(path.join(home, 'account-switch.json'), 'utf8'), localJob);
  assert.equal(fs.existsSync(path.join(home, 'model-catalog.json')), false);
  assert.equal('setRemoteFollow' in service.actions, false);
  assert.equal('syncRemoteServers' in service.actions, false);
  for (const dir of ['clients', 'logs'])
    assert.equal(fileText(path.join(home, dir)).includes(secret), false);
});

test('代理安装与诊断导出记录脱敏原因和远端概况，不导出正文、密钥或URL查询', async (t) => {
  const home = fixture(t),
    codexHome = path.join(home, 'codex');
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model="local-keep"\n');
  t.mock.method(clients, 'scanAsync', async () => ({ ancestry: [], processes: [] }));
  const service = require('../src/server/service.cjs').createService({
      codexHome,
      bridgeHome: home,
    }),
    input = registration('remote-install-log-window');
  input.remoteAgent.current.baseUrl = 'https://api.example.test/v1?token=sk-fixture-install-secret';
  clients.heartbeat(home, input);
  let pending = service.actions.installRemoteAgent({ id: input.id }),
    command = await nextCommand(home, input.id);
  assert.equal(command.type, 'installRemoteAgent');
  assert.ok(Buffer.from(command.base64, 'base64').byteLength > 1000);
  ack(home, input, command, { installed: true });
  assert.equal((await pending).installed, true);
  pending = service.actions.installRemoteAgent({ id: input.id });
  command = await nextCommand(home, input.id);
  clients.heartbeat(home, {
    ...input,
    ack: command.id,
    ackStatus: 'failed',
    ackError: '安装被拒绝 sk-fixture-install-secret',
  });
  await assert.rejects(pending, /安装被拒绝.*已隐藏/);
  const exported = await service.actions.exportDiagnostics(),
    header = JSON.parse(exported.text.split('\n---\n')[0]),
    last = require('../src/diagnostics/event-log.cjs').readRecent(home, 2);
  assert.deepEqual(
    last.map((row) => row.status),
    ['installed', 'failed'],
  );
  assert.match(last[1].reason, /安装被拒绝/);
  assert.equal(header.remotes[0].agentVersion, '0.1.3');
  assert.equal(header.remotes[0].companionVersion, '0.1.3');
  assert.deepEqual(header.remotes[0].current, { modelProvider: 'openai', model: 'old' });
  assert.equal(exported.text.includes('sk-fixture-install-secret'), false);
  assert.equal(exported.text.includes('ackResult'), false);
  assert.equal(fileText(path.join(home, 'clients')).includes('sk-fixture-install-secret'), false);
});

test('官方remoteSwitch读写auth与config，显式keyring服务器拒绝且不改服务器文件', async (t) => {
  const home = fixture(t),
    auth = {
      auth_mode: 'chatgpt',
      tokens: {
        account_id: 'workspace-official',
        access_token:
          'x.' +
          Buffer.from(
            JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_user_id: 'official-user' } }),
          ).toString('base64url') +
          '.x',
        id_token:
          'x.' +
          Buffer.from(
            JSON.stringify({
              email: 'official@example.test',
              'https://api.openai.com/auth': { chatgpt_user_id: 'official-user' },
            }),
          ).toString('base64url') +
          '.x',
        refresh_token: 'refresh-official',
      },
      last_refresh: new Date().toISOString(),
    },
    accountId = require('../src/accounts/accounts.cjs').identity(auth).id;
  fs.mkdirSync(path.join(home, 'accounts', accountId), { recursive: true });
  writeJson(path.join(home, 'accounts', 'index.json'), [
    { id: accountId, email: 'official@example.test' },
  ]);
  writeJson(path.join(home, 'accounts', accountId, 'auth.json'), auth);
  const input = registration('remote-official-window');
  input.remoteAgent.account = {
    id: accountId,
    email: 'official@example.test',
    plan: 'plus',
    lastRefresh: auth.last_refresh,
  };
  clients.heartbeat(home, input);
  const original =
    'model="remote-api-model"\nmodel_provider="hermes_bridge"\n\n[model_providers.hermes_bridge]\nname="Remote API"\nbase_url="https://api.example.test/v1"\nexperimental_bearer_token="old-secret"\n';
  let pending = remote.apply(home, input.authority, { auth }),
    command = await nextCommand(home, input.id);
  assert.equal(command.step, 'read');
  ack(home, input, command, { text: original, sha256: sha(original) });
  command = await nextCommand(home, input.id);
  assert.equal(command.step, 'readAuth');
  ack(home, input, command, { text: JSON.stringify(auth), sha256: sha(JSON.stringify(auth)) });
  command = await nextCommand(home, input.id);
  assert.equal(command.step, 'write');
  assert.equal(command.reload, true);
  assert.equal(command.text.includes('model_provider = "hermes_bridge"'), false);
  assert.equal(command.text.includes('remote-api-model'), false);
  assert.equal(command.text.includes('model_providers.hermes_bridge'), true);
  assert.equal(command.auth.text.includes('refresh-official'), true);
  assert.equal(command.auth.expectedSha256, sha(JSON.stringify(auth)));
  ack(home, input, command, {
    ok: true,
    sha256: sha(command.text),
    authSha256: sha(command.auth.text),
  });
  assert.deepEqual(await pending, [{ codexHome: input.remoteAgent.codexHome, status: 'synced' }]);
  // 常驻服务动作再次覆盖账号 id 边界，不能按邮箱或工作区猜测。
  const service = require('../src/server/service.cjs').createService({
      codexHome: path.join(home, 'local-codex'),
      bridgeHome: home,
    }),
    second = registration('remote-official-service-window');
  second.remoteAgent.account = input.remoteAgent.account;
  clients.heartbeat(home, second);
  const serviceRun = service.actions.remoteSwitch({ authority: second.authority, accountId });
  command = await nextCommand(home, second.id);
  ack(home, second, command, { text: original, sha256: sha(original) });
  command = await nextCommand(home, second.id);
  ack(home, second, command, { text: JSON.stringify(auth), sha256: sha(JSON.stringify(auth)) });
  command = await nextCommand(home, second.id);
  ack(home, second, command, {
    ok: true,
    sha256: sha(command.text),
    authSha256: sha(command.auth.text),
  });
  assert.deepEqual(await serviceRun, {
    results: [{ codexHome: second.remoteAgent.codexHome, status: 'synced' }],
  });
});
