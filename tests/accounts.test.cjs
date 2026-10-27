'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  { spawn } = require('node:child_process'),
  toml = require('smol-toml');
const { createAccounts, identity, writeJson } = require('../src/accounts/accounts.cjs'),
  { runSwitch: performSwitch } = require('../src/clients/desktop-account.cjs'),
  { readRecent } = require('../src/diagnostics/event-log.cjs');
// 业务单元检查不读取开发机上的其他编辑器；实际发现与重载由三窗口检查覆盖。
const runSwitch = (job, dependencies = {}) =>
  performSwitch(
    { threadFollow: 'all', target: '测试来源', ...job },
    {
      clients: () => ({ clients: [], inventory: { ancestry: [] } }),
      ...dependencies,
    },
  );
const sharedEditors = () => ({
  clients: [{ kind: 'ide', confirmed: true, shared: true, editorId: 'fixture-shared-editor' }],
  inventory: { ancestry: [] },
});
const jwt = (payload) =>
  'fixture.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.signature';
function auth(user, refresh = 'refresh-' + user, account = 'workspace-' + user, declaration = {}) {
  return {
    auth_mode: 'chatgpt',
    tokens: {
      account_id: account,
      access_token: jwt({
        'https://api.openai.com/auth': {
          amr: ['pwd'],
          chatgpt_account_id: account,
          chatgpt_account_user_id: user,
          chatgpt_compute_residency: 'test',
          chatgpt_user_id: user,
          chatgpt_plan_type: declaration.chatgpt_plan_type || 'plus',
          poid: user,
          user_id: user,
        },
      }),
      id_token: jwt({
        email: user + '@example.test',
        'https://api.openai.com/auth': {
          chatgpt_plan_type: declaration.chatgpt_plan_type || 'plus',
          chatgpt_subscription_active_start: declaration.chatgpt_subscription_active_start,
          chatgpt_subscription_active_until: declaration.chatgpt_subscription_active_until,
          chatgpt_subscription_last_checked: declaration.chatgpt_subscription_last_checked,
        },
      }),
      refresh_token: refresh,
    },
    last_refresh: new Date().toISOString(),
  };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-accounts-')),
    codexHome = path.join(root, 'codex'),
    bridgeHome = path.join(root, 'bridge'),
    children = [];
  fs.mkdirSync(codexHome);
  fs.mkdirSync(bridgeHome);
  t.after(async () => {
    // 登录终态先于进程回收；Windows 必须等子进程退出，才能删除它的工作目录。
    await Promise.all(
      children.map(async ({ child, closed }) => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed;
      }),
    );
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, codexHome, bridgeHome, children };
}
function configured(t) {
  const f = fixture(t);
  writeJson(path.join(f.codexHome, 'auth.json'), auth('alice'));
  fs.writeFileSync(
    path.join(f.codexHome, 'config.toml'),
    'model="official"\n[mcp_servers.keep]\ncommand="keep"\n',
  );
  return f;
}

test('account list captures current login, distinguishes workspaces, and never returns credentials', (t) => {
  const f = configured(t),
    a = createAccounts(f);
  let s = a.status();
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].email, 'alice@example.test');
  assert.equal(s.items[0].current, true);
  assert.equal(JSON.stringify(s).includes('refresh-alice'), false);
  assert.equal(JSON.stringify(s).includes('access_token'), false);
  const aliceId = s.items[0].id;
  a.rename(aliceId, '主账号');
  assert.equal(a.status().items[0].label, '主账号');
  writeJson(path.join(f.codexHome, 'auth.json'), auth('alice', 'new-refresh', 'workspace-team'));
  s = a.status();
  assert.equal(s.items.length, 2);
  assert.notEqual(s.items[0].id, s.items[1].id);
  assert.equal(s.items.filter((x) => x.current).length, 1);
  a.remove(aliceId);
  assert.equal(a.status().items.length, 1);
});

test('status reads the latest saved declarations for a non-current account', (t) => {
  const f = configured(t),
    a = createAccounts(f);
  const alice = a.status().items[0];
  writeJson(path.join(f.codexHome, 'auth.json'), auth('bob'));
  const bob = a.status().items.find((row) => row.current);
  writeJson(path.join(f.codexHome, 'auth.json'), auth('alice'));
  const until = '2026-11-30T00:00:00.000Z',
    checked = '2026-10-24T10:03:00.000Z',
    bobAuth = auth('bob', 'new-refresh-bob', 'workspace-bob', {
      chatgpt_plan_type: 'free',
      chatgpt_subscription_active_until: until,
      chatgpt_subscription_last_checked: checked,
    });
  writeJson(path.join(f.bridgeHome, 'accounts', bob.id, 'auth.json'), bobAuth);
  const rows = a.status().items,
    saved = rows.find((row) => row.id === bob.id);
  assert.equal(rows.find((row) => row.id === alice.id).current, true);
  assert.equal(saved.plan, 'free');
  assert.equal(saved.subscriptionUntil, until);
  assert.equal(saved.subscriptionCheckedAt, checked);
  assert.equal(saved.refreshedAt, bobAuth.last_refresh);
  assert.equal(JSON.stringify(saved).includes('new-refresh-bob'), false);
});

test('switch waits for desktop exit, preserves refreshed outgoing credentials, and restores official model/catalog', async (t) => {
  const f = configured(t),
    a = loginFixture(f);
  const alice = a.status().items[0];
  writeJson(path.join(f.codexHome, 'auth.json'), auth('bob'));
  const bob = a.status().items.find((x) => x.current);
  a.rename(bob.id, '备用账号');
  writeJson(path.join(f.codexHome, 'auth.json'), auth('alice'));
  fs.writeFileSync(
    path.join(f.codexHome, 'config.toml'),
    'model="custom"\nmodel_provider="hermes_bridge"\nmodel_catalog_json="C:/bridge-models.json"\n[mcp_servers.keep]\ncommand="keep"\n[model_providers.hermes_bridge]\nbase_url="http://localhost:1/v1"\nrequires_openai_auth=false\n',
  );
  const events = [];
  await runSwitch(
    { ...f, id: bob.id, model: 'official', desktopExe: 'fixture-desktop.exe' },
    {
      accounts: a,
      syncThreads: async () => {
        events.push('sync');
        return { updated: 2, skipped: 0, failed: 0 };
      },
      stop: async () => {
        events.push('stop');
        writeJson(path.join(f.codexHome, 'auth.json'), auth('alice', 'REFRESHED_BEFORE_EXIT'));
      },
      open: async () => {
        events.push('open');
        assert.equal(
          identity(JSON.parse(fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8'))).id,
          bob.id,
        );
        return { pid: 12345, startedAt: new Date().toISOString() };
      },
    },
  );
  assert.deepEqual(events, ['stop', 'sync', 'open']);
  assert.equal(a.status().switchJob.threads.updated, 2);
  const progress = a.status().switchJob;
  assert.equal(progress.configurationApplied, true);
  assert.equal(progress.desktopRequested, true);
  assert.equal(progress.desktopStarted.pid, 12345);
  assert.ok(progress.elapsedMs >= 0);
  for (const id of ['prepare', 'stop', 'apply', 'threads', 'reopen']) {
    const step = progress.steps.find((s) => s.id === id);
    assert.equal(step.status, 'done');
    assert.ok(step.durationMs >= 0);
  }
  const c = toml.parse(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'));
  assert.equal(c.model, 'official');
  assert.equal(c.model_provider, undefined);
  assert.equal(c.model_catalog_json, undefined);
  assert.equal(c.mcp_servers.keep.command, 'keep');
  assert.equal(c.service_tier, undefined);
  assert.ok(c.model_providers.hermes_bridge);
  assert.equal(a.status().items.find((x) => x.current).id, bob.id);
  a.apply(alice.id, 'official');
  assert.equal(
    toml.parse(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8')).service_tier,
    undefined,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8')).tokens.refresh_token,
    'REFRESHED_BEFORE_EXIT',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.bridgeHome, 'account-switch.json'), 'utf8')).status,
    'done',
  );
});

function loginFixture(
  f,
  {
    cancel = false,
    loginUser = 'new-user',
    failPrepare = false,
    earlyCompletion = false,
    failLogin = false,
  } = {},
) {
  const fake = path.join(f.root, 'fake-app-server.cjs');
  fs.writeFileSync(
    fake,
    `const fs = require('fs'), path = require('path'), rl = require('readline');
const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
const complete = (loginId, success, error = null) =>
  send({ method: 'account/login/completed', params: { loginId, success, error } });
rl.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'account/read') {
    const file = path.join(process.env.CODEX_HOME, 'auth.json');
    if (${failPrepare}) { send({ id: m.id, error: { code: 401, message: 'fixture rejected' } }); return; }
    const auth = JSON.parse(fs.readFileSync(file));
    auth.tokens.refresh_token += '-prepared';
    fs.writeFileSync(file, JSON.stringify(auth));
    send({ id: m.id, result: { account: { type: 'chatgpt', email: 'fixture@example.test' } } });
    return;
  }
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  if (m.method === 'account/login/start') {
    const finish = () => {
      fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), ${JSON.stringify(JSON.stringify(auth(loginUser)))});
      complete('fixture-login', ${!failLogin}, ${failLogin ? JSON.stringify('callback timed out code=SECRET https://auth.openai.com/?token=PRIVATE') : 'null'});
      if (${earlyCompletion}) complete('fixture-login', false, 'late failure');
    };
    if (${earlyCompletion}) { complete('previous-login', false, 'old cancellation'); finish(); }
    send({ id: m.id, result: { type: 'chatgpt', loginId: 'fixture-login', authUrl: 'https://auth.openai.com/fixture-login' } });
    if (!${cancel} && !${earlyCompletion}) setTimeout(finish, 50);
  }
  if (m.method === 'account/login/cancel') {
    send({ id: m.id, result: { status: 'canceled' } });
    complete('fixture-login', false, 'cancelled');
  }
});`,
  );
  return createAccounts({
    ...f,
    codexExe: process.execPath,
    spawnProcess: (_exe, args, options) => {
      const child = spawn(process.execPath, [fake, ...args], options),
        closed = new Promise((resolve) => child.once('close', resolve));
      f.children.push({ child, closed });
      return child;
    },
  });
}

test('当前账号访问令牌过期时，先向官方服务刷新而非直接要求重新登录', async (t) => {
  const f = configured(t),
    expired = auth('alice');
  const payload = JSON.parse(Buffer.from(expired.tokens.access_token.split('.')[1], 'base64url'));
  expired.tokens.access_token = jwt({ ...payload, exp: 1 });
  writeJson(path.join(f.codexHome, 'auth.json'), expired);
  const a = loginFixture(f),
    id = a.status().items[0].id;
  await a.prepare(id);
  const saved = JSON.parse(fs.readFileSync(path.join(f.bridgeHome, 'accounts', id, 'auth.json')));
  assert.match(saved.tokens.refresh_token, /-prepared$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.codexHome, 'auth.json'))), expired);
  const rejected = loginFixture(f, { failPrepare: true });
  await assert.rejects(
    rejected.prepare(id),
    (error) => error.kind === 'auth_invalid' && /官方登录已失效/.test(error.message),
  );
  const unavailable = createAccounts({
    ...f,
    codexExe: process.execPath,
    spawnProcess: (_exe, _args, options) =>
      spawn(
        process.execPath,
        [
          '-e',
          "require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)console.log(JSON.stringify(m.method==='initialize'?{id:m.id,result:{}}:{id:m.id,error:{code:-32000,message:'failed to refresh token: connection timed out'}}));});",
        ],
        options,
      ),
  });
  await assert.rejects(
    unavailable.prepare(id),
    (error) => error.kind === 'network_error' && /尚未确认登录失效/.test(error.message),
  );
  const missing = createAccounts({
    ...f,
    codexExe: () => {
      throw Object.assign(Error('fixture runtime missing'), { code: 'CODEX_NOT_FOUND' });
    },
  });
  await assert.rejects(
    missing.prepare(id),
    (error) => error.kind === 'runtime_error' && /程序不可用/.test(error.message),
  );
});

test('非当前官方账号的有效令牌直接准备，不启动额外 app-server', async (t) => {
  const f = configured(t),
    initial = createAccounts(f);
  initial.status();
  const valid = auth('bob');
  valid.tokens.access_token = jwt({
    ...JSON.parse(Buffer.from(valid.tokens.access_token.split('.')[1], 'base64url')),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  writeJson(path.join(f.codexHome, 'auth.json'), valid);
  const bob = initial.status().items.find((row) => row.current);
  writeJson(path.join(f.codexHome, 'auth.json'), auth('alice'));
  initial.status();
  let launches = 0;
  const accounts = createAccounts({
    ...f,
    codexExe: process.execPath,
    spawnProcess: () => {
      launches++;
      throw Error('不应启动额外官方进程');
    },
  });
  await accounts.prepare(bob.id);
  assert.equal(launches, 0);
});

test('相同模型切换官方账号仍会停止旧插件后端', async (t) => {
  const f = configured(t),
    a = loginFixture(f);
  a.status();
  writeJson(path.join(f.codexHome, 'auth.json'), auth('bob'));
  const bob = a.status().items.find((p) => p.current);
  writeJson(path.join(f.codexHome, 'auth.json'), auth('alice'));
  let stops = 0;
  const clients = require('../src/clients/client-status.cjs');
  t.mock.method(clients, 'stopEditorBackends', async () => {
    assert.equal(
      identity(JSON.parse(fs.readFileSync(path.join(f.codexHome, 'auth.json')))).id !== bob.id,
      true,
    );
    stops++;
    return [];
  });
  t.mock.method(clients, 'requestReload', () => ({ count: 0, targets: [] }));
  await runSwitch(
    { ...f, id: bob.id, model: 'official', desktopExe: null },
    {
      accounts: a,
      clients: sharedEditors,
      syncThreads: async () => {
        assert.equal(stops, 1);
        return { updated: 0, skipped: 0, failed: 0 };
      },
    },
  );
  assert.equal(stops, 1);
  assert.equal(
    identity(JSON.parse(fs.readFileSync(path.join(f.codexHome, 'auth.json')))).id,
    bob.id,
  );
});
test('official login completion adds the new account without changing the active desktop login', async (t) => {
  const f = configured(t),
    a = loginFixture(f),
    before = fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8');
  const start = await a.startLogin();
  assert.equal(start.status, 'waiting');
  assert.equal(start.authUrl, 'https://auth.openai.com/fixture-login');
  const until = Date.now() + 5000;
  while (a.status().login.status === 'waiting' && Date.now() < until)
    await new Promise((r) => setTimeout(r, 20));
  const s = a.status();
  assert.equal(s.login.status, 'done');
  assert.equal(s.items.length, 2);
  assert.equal(s.items.find((x) => x.current).email, 'alice@example.test');
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8'), before);
  const loginRoot = path.join(f.bridgeHome, 'accounts', 'login');
  for (const attempt of fs.readdirSync(loginRoot))
    assert.equal(fs.existsSync(path.join(loginRoot, attempt, 'auth.json')), false);
  assert.equal(JSON.stringify(s).includes('refresh-new-user'), false);
});
test('canceling an official login leaves saved and active accounts intact', async (t) => {
  const f = configured(t),
    a = loginFixture(f, { cancel: true });
  await a.startLogin();
  await a.cancelLogin();
  assert.equal(a.status().login.status, 'cancelled');
  assert.equal(a.status().items.length, 1);
});

test('登录完成通知早于 start 响应时仍保存账号，忽略旧取消和成功后的失败', async (t) => {
  const f = configured(t),
    a = loginFixture(f, { earlyCompletion: true }),
    before = fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8');
  await a.startLogin();
  const s = await waitLogin(a);
  assert.equal(s.login.status, 'done');
  assert.equal(s.items.length, 2);
  assert.equal(s.items.filter((row) => row.email === 'new-user@example.test').length, 1);
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8'), before);
});

test('登录失败保留具体原因和已落盘凭证，重试使用独立目录', async (t) => {
  const f = configured(t),
    a = loginFixture(f, { failLogin: true }),
    before = fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8');
  for (let count = 1; count <= 2; count++) {
    await a.startLogin();
    const s = await waitLogin(a);
    assert.equal(s.login.status, 'error');
    assert.match(s.login.message, /callback timed out/);
    assert.doesNotMatch(s.login.message, /SECRET|PRIVATE/);
    assert.equal(s.items.length, 1);
    const loginRoot = path.join(f.bridgeHome, 'accounts', 'login'),
      attempts = fs.readdirSync(loginRoot);
    assert.equal(attempts.length, count);
    for (const attempt of attempts) {
      const saved = JSON.parse(fs.readFileSync(path.join(loginRoot, attempt, 'auth.json')));
      assert.equal(identity(saved).email, 'new-user@example.test');
    }
  }
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8'), before);
});

test('不同单账号请求共用两个额度名额，排队请求合并，失败后释放名额', async (t) => {
  const { createQuotaReader } = require('../src/accounts/quota-reader.cjs'),
    ids = ['slow', 'fast', 'failed', 'queued'],
    gates = new Map(),
    started = [],
    cache = new Map();
  let active = 0,
    peak = 0;
  for (const id of ids) {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    gates.set(id, { promise, resolve, reject });
  }
  const reader = createQuotaReader({
    bridgeHome: fixture(t).bridgeHome,
    root: 'fixture',
    load: () => ids.map((id) => ({ id })),
    authFile: (id) => path.join('fixture', id, 'auth.json'),
    captureCurrent: () => {},
    readJson: (file, fallback) => cache.get(file) || fallback,
    writeJson: (file, value) => cache.set(file, value),
    openSession: (home) => {
      const id = path.basename(home);
      started.push(id);
      peak = Math.max(peak, ++active);
      return {
        ready: async () => {},
        rpc: async (method) =>
          method === 'account/read' ? { account: { type: 'chatgpt' } } : gates.get(id).promise,
        close: async () => {
          active--;
        },
      };
    },
  });
  const requests = ids.map((id) => reader.quota(id)),
    response = { rateLimits: { primary: { usedPercent: 25 } } };
  assert.equal(reader.quota('queued'), requests[3]);
  assert.deepEqual(started, ['slow', 'fast']);
  gates.get('fast').resolve(response);
  assert.equal((await requests[1]).status, 'ok');
  await new Promise(setImmediate);
  assert.deepEqual(started, ['slow', 'fast', 'failed']);
  gates
    .get('failed')
    .reject(Object.assign(Error('fixture network failure'), { reason: 'network' }));
  assert.equal((await requests[2]).errorKind, 'network_error');
  await new Promise(setImmediate);
  assert.deepEqual(started, ids);
  gates.get('queued').resolve(response);
  gates.get('slow').resolve(response);
  await Promise.all(requests);
  await new Promise(setImmediate);
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

test('missing runtime leaves login retryable and reports the real quota failure', async (t) => {
  const f = configured(t),
    a = createAccounts({
      ...f,
      codexExe: () => {
        throw Object.assign(Error('fixture runtime missing'), { code: 'CODEX_NOT_FOUND' });
      },
    });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(a.startLogin(), /fixture runtime missing/);
    assert.equal(a.status().login.status, 'error');
  }
  const id = a.status().items[0].id,
    result = await a.quota(id);
  assert.equal(result.error, 'fixture runtime missing');
  assert.equal(result.errorKind, 'runtime_error');
  assert.equal(result.status, 'error');
});

test('IDE-only official switch works with no desktop, model or model cache', async (t) => {
  const f = configured(t),
    a = createAccounts(f),
    id = a.status().items[0].id;
  fs.writeFileSync(
    path.join(f.codexHome, 'config.toml'),
    'model="api-model"\nmodel_provider="hermes_bridge"\n[mcp_servers.keep]\ncommand="keep"\n',
  );
  await runSwitch(
    { ...f, id, desktopExe: null, reloadEditors: false },
    {
      accounts: a,
      stop: () => assert.fail('must not stop desktop'),
      open: () => assert.fail('must not open desktop'),
    },
  );
  const c = toml.parse(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'));
  assert.equal(c.model, undefined);
  assert.equal(c.model_provider, undefined);
  assert.equal(c.mcp_servers.keep.command, 'keep');
  assert.equal(a.status().switchJob.status, 'done');
});

test('关闭旧对话跟随时不调用同步，继续同步只重跑设置而不再次应用账号', async (t) => {
  const f = configured(t),
    a = loginFixture(f),
    id = a.status().items[0].id;
  await runSwitch(
    { ...f, id, threadFollow: 'off', desktopExe: null, reloadEditors: false },
    {
      accounts: a,
      syncThreads: async () => assert.fail('关闭时不能启动会话同步后端'),
    },
  );
  assert.deepEqual(a.status().switchJob.threads, { updated: 0, skipped: 0, failed: 0 });
  await runSwitch(
    {
      ...f,
      id: 'thread-sync',
      resumeThreads: true,
      threadFollow: 'matching',
      previousProvider: 'openai',
      desktopExe: null,
      reloadEditors: false,
    },
    {
      accounts: {
        syncCurrent: async () => {},
        prepare: () => assert.fail('不能再次登录'),
        apply: () => assert.fail('不能再次应用账号'),
      },
      syncThreads: async (input) => {
        assert.equal(input.previousProvider, 'openai');
        assert.equal(input.mode, 'matching');
        return { updated: 1, skipped: 2, failed: 0 };
      },
    },
  );
  const job = a.status().switchJob;
  assert.deepEqual(job.threads, { updated: 1, skipped: 2, failed: 0 });
  assert.equal(job.previousProvider, 'openai');
  assert.equal(Object.hasOwn(job, 'threadRouting'), false);
});

test('old-thread synchronization failure is not reported as a completed switch', async (t) => {
  const f = configured(t),
    a = loginFixture(f),
    id = a.status().items[0].id;
  await assert.rejects(
    runSwitch(
      { ...f, id, model: 'official', desktopExe: 'fixture-desktop.exe' },
      {
        accounts: a,
        stop: async () => {},
        open: async () => assert.fail('must not reopen before thread synchronization succeeds'),
        syncThreads: async () => {
          throw Error('fixture active writer');
        },
      },
    ),
    /fixture active writer/,
  );
  assert.equal(a.status().switchJob.status, 'error');
  assert.equal(a.status().switchJob.steps.find((s) => s.id === 'threads').status, 'error');
  assert.equal(
    a.status().switchJob.steps.some((s) => s.id === 'reopen'),
    false,
  );
  assert.equal(
    require('../src/config/switch-state.cjs').readEffect(f.codexHome, f.bridgeHome).status,
    'switch_incomplete',
  );
});
test('插件没有重载通道时在关闭客户端和修改配置之前停止切换', async (t) => {
  const f = configured(t),
    a = loginFixture(f),
    id = a.status().items[0].id;
  const before = fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8');
  await assert.rejects(
    runSwitch(
      { ...f, id, desktopExe: 'fixture-desktop.exe' },
      {
        accounts: a,
        clients: () => ({
          clients: [{ pid: 811, kind: 'ide', confirmed: true, shared: true, editorId: null }],
          inventory: { ancestry: [] },
        }),
        stop: () => assert.fail('must not stop desktop'),
        open: () => assert.fail('must not open desktop'),
      },
    ),
    /未关联到编辑器窗口/,
  );
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'), before);
  assert.equal(a.status().switchJob.configurationApplied, false);
  await assert.rejects(
    runSwitch(
      { ...f, id, desktopExe: 'fixture-desktop.exe' },
      {
        accounts: a,
        clients: () => ({
          clients: [{ kind: 'ide', confirmed: false }],
          inventory: { ancestry: [] },
        }),
        stop: () => assert.fail('must not stop unknown client'),
      },
    ),
    /无法确认部分 Codex 插件后端/,
  );
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'), before);
});

test('旧对话同步失败后恢复已停止的插件，保留失败状态和重载反馈', async (t) => {
  const f = configured(t),
    a = loginFixture(f),
    id = a.status().items[0].id;
  const client = require('../src/clients/client-status.cjs');
  const editor = { editorId: 'fixture-editor', name: 'VS Code' };
  let reloads = 0,
    rejectRecovery = false;
  t.mock.method(client, 'stopEditorBackends', async () => [editor]);
  t.mock.method(client, 'requestReload', (home, bridge, { stoppedEditors }) => {
    assert.deepEqual(stoppedEditors, [editor]);
    reloads++;
    if (rejectRecovery) throw Error('fixture reload unavailable');
    return { count: 1, targets: [{ id: editor.editorId, commandId: 'fixture-recovery' }] };
  });
  await assert.rejects(
    runSwitch(
      { ...f, id, desktopExe: null },
      {
        accounts: a,
        clients: sharedEditors,
        syncThreads: async () => {
          throw Error('fixture sync failure');
        },
      },
    ),
    /fixture sync failure/,
  );
  assert.equal(reloads, 1);
  assert.equal(a.status().switchJob.status, 'error');
  assert.equal(a.status().switchJob.editorReload.count, 1);
  rejectRecovery = true;
  await assert.rejects(
    runSwitch(
      { ...f, id, desktopExe: null },
      {
        accounts: a,
        clients: sharedEditors,
        syncThreads: async () => {
          throw Error('fixture sync failure');
        },
      },
    ),
    /fixture sync failure/,
  );
  assert.match(a.status().switchJob.message, /插件恢复请求未发送：fixture reload unavailable/);
  assert.equal(a.status().switchJob.status, 'error');
});

test('quota requests deduplicate only the same account and publish each result independently', async (t) => {
  const f = configured(t),
    started = [];
  let releaseSlow;
  const slow = new Promise((resolve) => {
      releaseSlow = resolve;
    }),
    fake = path.join(f.root, 'quota-server.cjs');
  fs.writeFileSync(
    fake,
    `require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);const send=result=>process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');if(m.method==='initialize')send({});if(m.method==='account/read')send({account:{type:'chatgpt'}});if(m.method==='account/rateLimits/read')send({rateLimits:{primary:{usedPercent:25,windowDurationMins:300}}})});`,
  );
  const a = createAccounts({
    ...f,
    codexExe: process.execPath,
    spawnProcess: (_exe, args, options) => {
      started.push(options.cwd);
      const p = spawn(process.execPath, [fake, ...args], options);
      if (options.cwd.includes(identity(auth('alice')).id)) {
        const write = p.stdin.write.bind(p.stdin);
        p.stdin.write = (data, ...rest) => {
          if (data.includes('rateLimits/read')) {
            slow.then(() => write(data, ...rest));
            return true;
          }
          return write(data, ...rest);
        };
      }
      return p;
    },
  });
  const alice = a.status().items[0];
  writeJson(path.join(f.codexHome, 'auth.json'), auth('bob'));
  const bob = a.status().items.find((x) => x.current);
  const first = a.quota(alice.id);
  assert.equal(a.quota(alice.id), first);
  t.after(releaseSlow);
  const second = await a.quota(bob.id);
  assert.equal(second.status, 'ok');
  assert.equal(second.buckets[0].windows[0].remainingPercent, 75);
  assert.equal(started.length, 2);
  assert.equal(a.status().items.find((x) => x.id === alice.id).quota, null);
  releaseSlow();
  assert.equal((await first).status, 'ok');
});

test('older live auth does not replace the refreshed saved login', (t) => {
  const f = configured(t),
    a = createAccounts(f),
    row = a.status().items[0];
  const older = auth('alice', 'old-refresh');
  older.last_refresh = '2026-01-01T00:00:00Z';
  writeJson(path.join(f.codexHome, 'auth.json'), older);
  const refreshed = auth('alice', 'fresh-refresh');
  refreshed.last_refresh = '2026-01-02T00:00:00Z';
  writeJson(path.join(f.bridgeHome, 'accounts', row.id, 'auth.json'), refreshed);
  a.status();
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.bridgeHome, 'accounts', row.id, 'auth.json'))).tokens
      .refresh_token,
    'fresh-refresh',
  );
  older.last_refresh = '2026-01-03T00:00:00Z';
  writeJson(path.join(f.codexHome, 'auth.json'), older);
  a.status();
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.bridgeHome, 'accounts', row.id, 'auth.json'))).tokens
      .refresh_token,
    'old-refresh',
  );
});

test('applying a saved account selects file credentials instead of a different keyring identity', (t) => {
  const f = configured(t),
    a = createAccounts(f),
    id = a.status().items[0].id;
  fs.writeFileSync(
    path.join(f.codexHome, 'config.toml'),
    'model="official"\ncli_auth_credentials_store="keyring"\n[mcp_servers.keep]\ncommand="keep"\n',
  );
  a.apply(id, 'official');
  const config = toml.parse(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'));
  assert.equal(config.cli_auth_credentials_store, 'file');
  assert.equal(config.mcp_servers.keep.command, 'keep');
  assert.equal(identity(JSON.parse(fs.readFileSync(path.join(f.codexHome, 'auth.json')))).id, id);
});

async function waitLogin(a) {
  const end = Date.now() + 5000;
  while (a.status().login?.status === 'waiting' && Date.now() < end)
    await new Promise((r) => setTimeout(r, 20));
  return a.status();
}
test('reauthentication updates the same account without old live auth overwriting it', async (t) => {
  const f = configured(t),
    a = loginFixture(f, { loginUser: 'alice' }),
    row = a.status().items[0];
  a.rename(row.id, '主账号');
  const before = fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8');
  await a.startLogin({ id: row.id });
  let s = await waitLogin(a);
  assert.equal(s.login.status, 'done');
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].id, row.id);
  assert.equal(s.items[0].label, '主账号');
  assert.equal(s.items[0].pendingLogin, true);
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8'), before);
  const saved = fs.readFileSync(path.join(f.bridgeHome, 'accounts', row.id, 'auth.json'), 'utf8');
  a.status();
  assert.equal(
    fs.readFileSync(path.join(f.bridgeHome, 'accounts', row.id, 'auth.json'), 'utf8'),
    saved,
  );
  a.apply(row.id, 'official');
  assert.equal(a.status().items[0].pendingLogin, false);
  const wrong = loginFixture(f, { loginUser: 'other' });
  await wrong.startLogin({ id: row.id });
  s = await waitLogin(wrong);
  assert.equal(s.login.status, 'error');
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].id, row.id);
});

test('preparation failure preserves the running desktop and active configuration', async (t) => {
  const f = configured(t),
    a = loginFixture(f, { failPrepare: true });
  a.status();
  writeJson(path.join(f.codexHome, 'auth.json'), auth('bob'));
  const bob = a.status().items.find((x) => x.current);
  const expiredBob = auth('bob');
  expiredBob.tokens.access_token = jwt({
    ...JSON.parse(Buffer.from(expiredBob.tokens.access_token.split('.')[1], 'base64url')),
    exp: 1,
  });
  writeJson(path.join(f.bridgeHome, 'accounts', bob.id, 'auth.json'), expiredBob);
  writeJson(path.join(f.codexHome, 'auth.json'), auth('alice'));
  const authBefore = fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8'),
    configBefore = fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8');
  let stopped = false;
  await assert.rejects(
    runSwitch(
      { ...f, id: bob.id, model: 'official' },
      {
        accounts: a,
        stop: async () => {
          stopped = true;
        },
        open: async () => assert.fail('must not open'),
      },
    ),
    /未关闭桌面端/,
  );
  assert.equal(stopped, false);
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8'), authBefore);
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'), configBefore);
  assert.equal(a.status().switchJob.status, 'error');
});

test('a second service cannot mutate configuration throughout background preparation and reopening', async (t) => {
  const f = configured(t),
    a = loginFixture(f),
    op = require('../src/config/switch-state.cjs');
  a.status();
  writeJson(path.join(f.codexHome, 'auth.json'), auth('bob'));
  const bob = a.status().items.find((x) => x.current);
  writeJson(path.join(f.codexHome, 'auth.json'), auth('alice'));
  const { createService } = require('../src/server/service.cjs'),
    other = createService(f);
  let continuePrepare;
  const gate = new Promise((r) => {
    continuePrepare = r;
  });
  op.acquire(f.bridgeHome);
  const task = runSwitch(
    { ...f, id: bob.id, model: 'official' },
    {
      accounts: {
        ...a,
        prepare: async (id) => {
          await gate;
          return a.prepare(id);
        },
      },
      stop: async () => {},
      open: async () => {
        assert.equal(a.status().switchJob.status, 'reopening');
        await assert.rejects(
          other.actions.accountRename({ id: bob.id, label: 'blocked' }),
          /切换正在进行/,
        );
      },
    },
  );
  assert.equal(a.status().switchJob.status, 'preparing');
  await assert.rejects(other.actions.switch({ id: 'official', model: 'other' }), /切换正在进行/);
  await assert.rejects(other.actions.providerAdd({ name: 'blocked' }), /切换正在进行/);
  continuePrepare();
  await task;
  assert.equal(fs.existsSync(path.join(f.bridgeHome, 'operation.lock')), false);
  assert.equal((await other.state()).effect.status, 'reopen_requested');
  await other.actions.accountRename({ id: bob.id, label: 'allowed' });
  assert.equal(a.status().items.find((x) => x.id === bob.id).label, 'allowed');
});

test('准备阶段并行检查登录和编辑器，两项都通过后才关闭桌面', async (t) => {
  const f = configured(t),
    a = createAccounts(f),
    id = a.status().items[0].id;
  const started = [];
  let finishAuth,
    finishEditors,
    stopped = false;
  const authReady = new Promise((resolve) => {
    finishAuth = resolve;
  });
  const editorsReady = new Promise((resolve) => {
    finishEditors = resolve;
  });
  t.after(() => {
    finishAuth();
    finishEditors({ clients: [], inventory: { ancestry: [] } });
  });
  const task = runSwitch(
    { ...f, id, model: 'official', desktopExe: 'fixture-desktop.exe' },
    {
      accounts: {
        ...a,
        prepare: async () => {
          started.push('auth');
          await authReady;
        },
      },
      clients: async () => {
        started.push('editors');
        return editorsReady;
      },
      stop: async () => {
        stopped = true;
      },
      open: async () => ({ pid: 1 }),
      syncThreads: async () => ({ updated: 0, skipped: 0, failed: 0 }),
    },
  );
  await new Promise(setImmediate);
  assert.deepEqual(started, ['auth', 'editors']);
  finishAuth();
  await new Promise(setImmediate);
  assert.equal(stopped, false);
  finishEditors({ clients: [], inventory: { ancestry: [] } });
  await task;
  assert.equal(stopped, true);
});

test('并行检查失败后等待另一项收尾，期间保留切换锁且不修改配置', async (t) => {
  const f = configured(t),
    a = createAccounts(f),
    id = a.status().items[0].id;
  const before = fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8');
  const op = require('../src/config/switch-state.cjs');
  let finishAuth,
    finished = false;
  const authReady = new Promise((resolve) => {
    finishAuth = resolve;
  });
  t.after(() => finishAuth());
  op.acquire(f.bridgeHome);
  const task = runSwitch(
    { ...f, id, desktopExe: 'fixture-desktop.exe' },
    {
      accounts: {
        ...a,
        prepare: async () => {
          await authReady;
          finished = true;
        },
      },
      clients: async () => {
        throw Error('fixture editor check failed');
      },
      stop: async () => assert.fail('校验失败不能关闭桌面'),
    },
  );
  const rejected = assert.rejects(task, /fixture editor check failed/);
  await new Promise(setImmediate);
  assert.equal(a.status().switchJob.status, 'preparing');
  assert.equal(fs.existsSync(path.join(f.bridgeHome, 'operation.lock')), true);
  assert.equal(finished, false);
  finishAuth();
  await rejected;
  assert.equal(finished, true);
  assert.equal(fs.existsSync(path.join(f.bridgeHome, 'operation.lock')), false);
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8'), before);
});

test('并行释放客户端失败时不应用配置，并恢复已经停止的编辑器', async (t) => {
  const f = configured(t),
    a = createAccounts(f),
    id = a.status().items[0].id,
    clients = require('../src/clients/client-status.cjs'),
    editor = { editorId: 'parallel-release-editor' },
    before = fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8');
  let releaseDesktop,
    releaseEditors,
    recovered = false,
    applied = false;
  const desktopGate = new Promise((resolve) => {
      releaseDesktop = resolve;
    }),
    editorGate = new Promise((resolve) => {
      releaseEditors = resolve;
    });
  t.mock.method(clients, 'stopEditorBackends', async () => {
    await editorGate;
    return [editor];
  });
  t.mock.method(clients, 'requestReload', (_home, _bridge, { stoppedEditors }) => {
    assert.deepEqual(stoppedEditors, [editor]);
    recovered = true;
    return { count: 1, targets: [] };
  });
  const task = runSwitch(
    { ...f, id, desktopExe: 'fixture-desktop.exe', threadFollow: 'off' },
    {
      clients: sharedEditors,
      accounts: {
        ...a,
        apply: () => {
          applied = true;
        },
      },
      stop: async () => {
        await desktopGate;
        throw Error('desktop release failed');
      },
      open: async () => assert.fail('释放失败不能启动桌面端'),
    },
  );
  const rejected = assert.rejects(task, /desktop release failed/);
  await new Promise(setImmediate);
  assert.equal(a.status().switchJob.steps.filter((s) => s.status === 'running').length, 2);
  releaseDesktop();
  await new Promise(setImmediate);
  assert.equal(recovered, false);
  assert.equal(applied, false);
  releaseEditors();
  await rejected;
  assert.equal(recovered, true);
  assert.equal(applied, false);
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'), before);
});

test('没有共用配置的编辑器时不执行释放和重载步骤', async (t) => {
  const f = configured(t),
    a = createAccounts(f),
    id = a.status().items[0].id,
    clients = require('../src/clients/client-status.cjs');
  t.mock.method(clients, 'stopEditorBackends', () => assert.fail('没有目标不能执行编辑器释放'));
  t.mock.method(clients, 'requestReload', () => assert.fail('没有目标不能派发重载'));
  await runSwitch({ ...f, id, desktopExe: null, threadFollow: 'off' }, { accounts: a });
  const job = a.status().switchJob;
  assert.equal(job.status, 'done');
  assert.equal(
    job.steps.some((step) => ['editors', 'reload'].includes(step.id)),
    false,
  );
  assert.match(job.message, /无共用配置的编辑器后端需要重载/);
});

test('账号准备期间出现的共用编辑器在关闭前重新检查并加入重载', async (t) => {
  const f = configured(t),
    a = createAccounts(f),
    id = a.status().items[0].id,
    clients = require('../src/clients/client-status.cjs'),
    editor = { editorId: 'fixture-shared-editor' };
  let checks = 0,
    stops = 0,
    reloads = 0;
  t.mock.method(clients, 'stopEditorBackends', async () => {
    stops++;
    return [editor];
  });
  t.mock.method(clients, 'requestReload', (_home, _bridge, { stoppedEditors }) => {
    assert.deepEqual(stoppedEditors, [editor]);
    reloads++;
    return { count: 1, targets: [] };
  });
  await runSwitch(
    { ...f, id, desktopExe: null, threadFollow: 'off' },
    {
      accounts: a,
      clients: () =>
        ++checks === 1 ? { clients: [], inventory: { ancestry: [] } } : sharedEditors(),
    },
  );
  assert.equal(checks, 2);
  assert.equal(stops, 1);
  assert.equal(reloads, 1);
});

test('后台进程在锁交接和排队状态写入后才收到开始消息，终态不被排队状态覆盖', async (t) => {
  const f = configured(t),
    cp = require('node:child_process'),
    op = require('../src/config/switch-state.cjs');
  const clients = require('../src/clients/client-status.cjs');
  t.mock.method(clients, 'clientStatus', () => ({
    clients: [{ kind: 'editor', confirmed: true, shared: true }],
  }));
  let started = false;
  t.mock.method(cp, 'spawn', (...args) => {
    const child = spawn(...args),
      closed = new Promise((resolve) => child.once('close', resolve));
    f.children.push({ child, closed });
    const send = child.send.bind(child);
    child.send = (message, ...rest) => {
      const queued = JSON.parse(fs.readFileSync(path.join(f.bridgeHome, 'account-switch.json')));
      const owner = JSON.parse(fs.readFileSync(path.join(f.bridgeHome, 'operation.lock')));
      assert.equal(queued.status, 'queued');
      assert.equal(queued.pid, child.pid);
      assert.equal(owner.pid, child.pid);
      started = true;
      return send(message, ...rest);
    };
    return child;
  });
  op.acquire(f.bridgeHome);
  require('../src/clients/desktop-account.cjs').scheduleSwitch({
    ...f,
    id: 'missing-fixture',
    threadFollow: 'all',
    reloadEditors: false,
  });
  // 正式后台有意 unref；测试宿主需要持有引用，等子进程终态后再结束事件循环。
  f.children[0].child.ref();
  await f.children[0].closed;
  assert.equal(started, true);
  assert.equal(op.switchJob(f.bridgeHome).status, 'error');
  assert.match(op.switchJob(f.bridgeHome).message, /账号不存在/);
  assert.equal(fs.existsSync(path.join(f.bridgeHome, 'operation.lock')), false);
});

test('API desktop switch prepares before closing, applies after closing, and allows retry after reopen failure', async (t) => {
  const f = configured(t),
    http = require('node:http'),
    store = require('../src/config/providers.cjs'),
    op = require('../src/config/switch-state.cjs');
  const upstream = http.createServer((q, r) => {
    r.setHeader('content-type', 'application/json');
    r.end(
      JSON.stringify(
        q.url.endsWith('/models')
          ? { data: [{ id: 'api-model' }] }
          : {
              object: 'response',
              status: 'completed',
              output: [{ type: 'function_call', name: 'bridge_ping' }],
            },
      ),
    );
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());
  const id = store.add(f.bridgeHome, {
    name: 'API fixture',
    baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1',
    apiMode: 'responses',
    apiKey: 'fixture-key',
    model: 'api-model',
  });
  const cache = path.join(os.homedir(), '.codex', 'models_cache.json');
  if (fs.existsSync(cache)) fs.copyFileSync(cache, path.join(f.codexHome, 'models_cache.json'));
  const authBefore = fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8'),
    configBefore = fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8');
  const catalogFile = path.join(f.bridgeHome, 'model-catalog.json');
  fs.writeFileSync(catalogFile, '{"models":[]}');
  let stopped = false;
  const job = { ...f, id, kind: 'api', model: 'api-model' };
  await runSwitch(job, {
    stop: async () => {
      assert.equal(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'), configBefore);
      assert.equal(fs.readFileSync(catalogFile, 'utf8'), '{"models":[]}');
      assert.equal(store.access(f.bridgeHome, store.list(f.bridgeHome)[0]).mode, 'direct');
      stopped = true;
    },
    open: async () => {
      assert.equal(stopped, true);
      assert.equal(
        toml.parse(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8')).model,
        'api-model',
      );
      assert.equal(fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8'), authBefore);
    },
  });
  assert.equal(op.switchJob(f.bridgeHome).status, 'done');
  assert.equal(op.readEffect(f.codexHome, f.bridgeHome).status, 'reopen_requested');
  await assert.rejects(
    runSwitch(job, {
      stop: async () => {},
      open: async () => {
        throw Error('fixture reopen failed');
      },
    }),
    /fixture reopen failed/,
  );
  assert.equal(op.readEffect(f.codexHome, f.bridgeHome).status, 'switch_incomplete');
  assert.match(
    op.switchJob(f.bridgeHome).message,
    /配置已应用，但旧对话同步或客户端重新加载未完成/,
  );
  await runSwitch(job, { stop: async () => {}, open: async () => {} });
  assert.equal(op.switchJob(f.bridgeHome).status, 'done');
  assert.equal(
    fs.readdirSync(f.bridgeHome).some((n) => n.endsWith('.prepared')),
    false,
  );
});

test('rejected API preparation leaves desktop, config and model catalog untouched', async (t) => {
  const f = configured(t),
    http = require('node:http'),
    store = require('../src/config/providers.cjs');
  const upstream = http.createServer((q, r) => {
    r.writeHead(401);
    r.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());
  const id = store.add(f.bridgeHome, {
    name: 'Rejected',
    baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1',
    apiMode: 'responses',
    apiKey: 'fixture-key',
    model: 'api-model',
  });
  const before = fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8');
  await assert.rejects(
    runSwitch(
      { ...f, id, kind: 'api', model: 'api-model' },
      {
        stop: async () => assert.fail('must not close desktop'),
        open: async () => assert.fail('must not reopen'),
      },
    ),
    /检测未通过/,
  );
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.bridgeHome, 'model-catalog.json')), false);
});

test('额度成功后按同一账号的固定订阅响应保存到期日，不刷新登录也不公开令牌', async (t) => {
  const f = configured(t),
    login = JSON.parse(fs.readFileSync(path.join(f.codexHome, 'auth.json'))),
    accountId = login.tokens.account_id;
  const reader = require('../src/accounts/quota-reader.cjs'),
    cp = require('node:child_process'),
    saved = path.join(f.bridgeHome, 'auth-fixture.json');
  writeJson(saved, login);
  let commandArgs, requestConfig, subscriptionResponse = 'success';
  t.mock.method(require('../src/platform/platform.cjs'), 'codexEnv', () => ({}));
  t.mock.method(cp, 'execFile', (_exe, args, _options, callback) => {
    commandArgs = args;
    process.nextTick(() =>
      subscriptionResponse === 'success'
        ? callback(
            null,
            JSON.stringify({
              accounts: {
                [accountId]: {
                  entitlement: {
                    expires_at: '2026-11-26T12:00:00+00:00',
                    renews_at: '2026-11-25T12:00:00+00:00',
                  },
                  last_active_subscription: { will_renew: false },
                },
                default: { entitlement: { expires_at: '2030-01-01T00:00:00Z' } },
              },
            }) + '\n__SWITCHER_HTTP_STATUS__:200',
          )
        : callback(Object.assign(Error('curl failed'), { code: 28 }), ''),
    );
    return {
      stdin: {
        on() {},
        end(config) {
          requestConfig = config;
        },
      },
    };
  });
  const q = reader.createQuotaReader({
    bridgeHome: f.bridgeHome,
    root: f.bridgeHome,
    load: () => [{ id: 'fixture', email: 'fixture@example.test' }],
    authFile: () => saved,
    captureCurrent() {},
    openSession: () => ({
      ready: async () => {},
      rpc: async (method) =>
        method === 'account/read'
          ? { account: { type: 'chatgpt' } }
          : {
              rateLimits: {
                planType: 'plus',
                primary: { usedPercent: 10, windowDurationMins: 300 },
              },
            },
      close: async () => {},
    }),
    readJson: (file, fallback) =>
      fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : fallback,
    writeJson,
    readSubscription: reader.readSubscription,
  });
  const result = await q.quota('fixture');
  assert.equal(result.status, 'ok');
  assert.equal(result.subscriptionUntil, '2026-11-26T12:00:00+00:00');
  assert.equal(result.subscriptionWillRenew, false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.bridgeHome, 'fixture', 'quota.json'))).subscriptionUntil,
    result.subscriptionUntil,
  );
  assert.ok(requestConfig.includes('ChatGPT-Account-Id: ' + accountId));
  assert.ok(requestConfig.includes('originator: codex_cli_rs'));
  assert.equal(commandArgs.includes('--location'), false);
  assert.equal(commandArgs.join(' ').includes(login.tokens.access_token), false);
  assert.equal(JSON.stringify(result).includes(login.tokens.access_token), false);
  const events = readRecent(f.bridgeHome, 10);
  assert.deepEqual(events.map(({ event, status, httpCode, curlCode, hasDate }) => ({ event, status, httpCode, curlCode, hasDate })), [
    { event: 'official.subscription', status: 'ok', httpCode: 200, curlCode: undefined, hasDate: true },
  ]);
  subscriptionResponse = 'failure';
  const failed = await q.quota('fixture');
  assert.equal(failed.status, 'ok');
  assert.deepEqual(
    readRecent(f.bridgeHome, 10).map(({ event, status, httpCode, curlCode, hasDate }) => ({ event, status, httpCode, curlCode, hasDate })),
    [
      { event: 'official.subscription', status: 'ok', httpCode: 200, curlCode: undefined, hasDate: true },
      { event: 'official.subscription', status: 'failed', httpCode: undefined, curlCode: 28, hasDate: false },
    ],
  );
});
