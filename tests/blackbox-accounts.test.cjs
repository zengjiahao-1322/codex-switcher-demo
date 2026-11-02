'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { api, algorithm } = require('./config-blackbox-helpers.cjs');
const rustBackend = process.env.SWITCHER_BACKEND === 'rust';
const {
  auth,
  accountId,
  officialFixture,
  until,
  accounts,
} = require('./official-blackbox-helpers.cjs');

test('官方账号HTTP：保存当前身份、区分工作区、改名删除且不公开凭证', async (t) => {
  const live = auth('alice'),
    f = await officialFixture(t, { live });
  const original = fs.readFileSync(path.join(f.home, 'auth.json'), 'utf8');
  let status = await accounts(f);
  const id = accountId('alice');
  assert.equal(status.items.length, 1);
  assert.equal(status.items[0].id, id);
  assert.equal(status.items[0].current, true);
  assert.equal(status.items[0].plan, 'plus');
  assert.equal(JSON.stringify(status).includes('fixture-refresh'), false);
  assert.equal(JSON.stringify(status).includes('access_token'), false);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.bridge, 'accounts', id, 'auth.json'))),
    live,
  );
  fs.writeFileSync(
    path.join(f.home, 'auth.json'),
    JSON.stringify(auth('alice', { workspace: 'workspace-other' }), null, 2),
  );
  status = await accounts(f);
  assert.equal(status.items.length, 2);
  assert.equal(status.items.filter((a) => a.current).length, 1);
  await api(f, 'accountRename', { id, label: '我的账号' });
  assert.equal((await accounts(f)).items.find((a) => a.id === id).label, '我的账号');
  await api(f, 'accountRemove', { id });
  assert.equal((await accounts(f)).items.length, 1);
  assert.equal(fs.existsSync(path.join(f.bridge, 'accounts', id, 'auth.json')), false);
  assert.equal(f.rpc().length, 0, 'Capture/list/rename/remove must not start app-server');
  assert.notEqual(fs.readFileSync(path.join(f.home, 'auth.json'), 'utf8'), original);
});
test('官方账号HTTP：非当前账号读取最新套餐并防止旧live覆盖新副本', async (t) => {
  const old = auth('alice'),
    f = await officialFixture(t, { live: old });
  await accounts(f);
  const id = accountId('alice');
  const newer = auth('alice', { plan: 'pro', refreshed: '2026-10-28T00:00:00Z' });
  const file = path.join(f.bridge, 'accounts', id, 'auth.json');
  fs.writeFileSync(file, JSON.stringify(newer, null, 2));
  const status = await accounts(f);
  assert.equal(status.items[0].plan, 'pro');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), newer);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'auth.json'))), old);
});

test('官方登录HTTP：隔离app-server等待与取消不改变live及账号库', async (t) => {
  const live = auth('alice'),
    f = await officialFixture(t, { live });
  await accounts(f);
  const before = fs.readFileSync(path.join(f.home, 'auth.json'), 'utf8');
  const login = await api(f, 'accountLogin', {});
  assert.equal(login.status, 'waiting');
  assert.equal(login.loginId, 'fixture-login');
  await api(f, 'accountLogin', {}, 400);
  await api(f, 'accountLoginCancel', {});
  await api(f, 'accountLoginCancel', {});
  assert.equal((await accounts(f)).login.status, 'cancelled');
  assert.equal(fs.readFileSync(path.join(f.home, 'auth.json'), 'utf8'), before);
  assert.equal((await accounts(f)).items.length, 1);
  const calls = f.rpc();
  assert.deepEqual(
    calls.filter((c) => c.id !== null).map((c) => c.method),
    ['initialize', 'account/login/start', 'account/login/cancel'],
  );
  assert.ok(
    calls.every((c) => c.home.startsWith(path.join(f.bridge, 'accounts', 'login') + path.sep)),
  );
});
test('官方登录HTTP：新账号完成只写入账号库、保留当前登录及配置', async (t) => {
  const live = auth('alice'),
    f = await officialFixture(t, { live });
  await accounts(f);
  const before = fs.readFileSync(path.join(f.home, 'auth.json'), 'utf8'),
    config = fs.readFileSync(path.join(f.home, 'config.toml'), 'utf8');
  const added = auth('bob');
  f.update((s) => {
    s.methods['account/login/start'].notifications = [
      {
        waitFile: 'complete-login',
        method: 'account/login/completed',
        params: { loginId: 'fixture-login', success: true },
        auth: added,
      },
    ];
  });
  await api(f, 'accountLogin', {});
  fs.writeFileSync(path.join(f.root, 'complete-login'), 'go');
  const status = await until(
    () => accounts(f),
    (s) => s.login?.status === 'done',
  );
  const id = accountId('bob');
  assert.equal(status.items.length, 2);
  assert.equal(status.login.accountId, id);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.bridge, 'accounts', id, 'auth.json'))),
    added,
  );
  assert.equal(fs.readFileSync(path.join(f.home, 'auth.json'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(f.home, 'config.toml'), 'utf8'), config);
  assert.equal(JSON.stringify(status).includes(added.tokens.refresh_token), false);
});
test('官方额度HTTP：真实RPC参数、持久缓存、独立目录且不刷新live', async (t) => {
  const live = auth('alice'),
    f = await officialFixture(t, { live });
  await accounts(f);
  const before = fs.readFileSync(path.join(f.home, 'auth.json'), 'utf8'),
    id = accountId('alice');
  const result = await api(f, 'accountQuota', { id });
  assert.equal(result.items[0].status, 'ok');
  assert.deepEqual(result.items[0].buckets, [
    {
      id: 'codex',
      name: 'codex',
      plan: 'plus',
      windows: [
        {
          key: 'primary',
          usedPercent: 20,
          remainingPercent: 80,
          minutes: 300,
          resetsAt: 2000000000,
        },
      ],
      credits: null,
    },
  ]);
  const disk = JSON.parse(fs.readFileSync(path.join(f.bridge, 'accounts', id, 'quota.json')));
  assert.deepEqual(disk, (({ id, ...r }) => r)(result.items[0]));
  assert.equal(fs.readFileSync(path.join(f.home, 'auth.json'), 'utf8'), before);
  assert.ok(f.rpc().every((c) => c.home === path.join(f.bridge, 'accounts', id)));
  assert.deepEqual(f.rpc().find((c) => c.method === 'account/read').params, {
    refreshToken: false,
  });
  assert.equal(JSON.stringify(result).includes('fixture-refresh'), false);
});
test('官方额度HTTP：即将到期当前令牌暂缓且完全不启动RPC', async (t) => {
  const f = await officialFixture(t, {
    live: auth('alice', { exp: Math.floor(Date.now() / 1000) + 60 }),
  });
  await accounts(f);
  const result = await api(f, 'accountQuota', { id: accountId('alice') });
  assert.equal(result.items[0].status, 'deferred');
  assert.equal(result.items[0].reason, 'token_refresh_pending');
  assert.deepEqual(f.rpc(), []);
});

test('官方登录HTTP：早到完成、旧loginId和迟到失败不会重复或覆盖成功', async (t) => {
  const live = auth('alice'),
    f = await officialFixture(t, { live });
  f.update((s) => {
    s.methods['account/login/start'].beforeResponse = [
      { method: 'account/login/completed', params: { loginId: 'old-login', success: false } },
      {
        method: 'account/login/completed',
        params: { loginId: 'fixture-login', success: true },
        auth: auth('bob'),
      },
      {
        method: 'account/login/completed',
        params: { loginId: 'fixture-login', success: false, error: 'late failure' },
      },
    ];
  });
  await api(f, 'accountLogin', {});
  const status = await until(
    () => accounts(f),
    (s) => s.login?.status === 'done',
  );
  assert.equal(status.items.length, 2);
  assert.equal(status.items.filter((a) => a.id === accountId('bob')).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'auth.json'))), live);
});

test('官方登录HTTP：失败脱敏、保留凭证且重试使用独立目录', async (t) => {
  const live = auth('alice'),
    added = auth('bob'),
    f = await officialFixture(t, { live });
  f.update((s) => {
    s.methods['account/login/start'].notifications = [
      {
        method: 'account/login/completed',
        params: {
          loginId: 'fixture-login',
          success: false,
          error: 'callback timed out https://example.test/PRIVATE code=SECRET token=PRIVATE',
        },
        auth: added,
      },
    ];
  });
  for (let count = 1; count <= 2; count++) {
    await api(f, 'accountLogin', {});
    const status = await until(
      () => accounts(f),
      (s) => s.login?.status === 'error',
    );
    assert.match(status.login.message, /callback timed out/);
    assert.doesNotMatch(status.login.message, /PRIVATE|SECRET/);
    assert.equal(status.items.length, 1);
    const directories = fs.readdirSync(path.join(f.bridge, 'accounts/login'));
    assert.equal(directories.length, count);
    for (const dir of directories)
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(f.bridge, 'accounts/login', dir, 'auth.json'))),
        added,
      );
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'auth.json'))), live);
});

test('官方登录HTTP：同账号重新登录保留标签且旧live不覆盖、错账号不替换', async (t) => {
  const live = auth('alice'),
    f = await officialFixture(t, { live });
  await accounts(f);
  const id = accountId('alice'),
    fresh = auth('alice', { refreshed: '2030-01-01T00:00:00Z' });
  await api(f, 'accountRename', { id, label: '主账号' });
  const complete = (value) =>
    f.update((s) => {
      s.methods['account/login/start'].notifications = [
        {
          method: 'account/login/completed',
          params: { loginId: 'fixture-login', success: true },
          auth: value,
        },
      ];
    });
  complete(fresh);
  await api(f, 'accountLogin', { id });
  let status = await until(
    () => accounts(f),
    (s) => s.login?.status === 'done',
  );
  assert.equal(status.items.length, 1);
  assert.equal(status.items[0].label, '主账号');
  assert.equal(status.items[0].pendingLogin, true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.bridge, 'accounts', id, 'auth.json'))),
    fresh,
  );
  complete(auth('other'));
  await api(f, 'accountLogin', { id });
  status = await until(
    () => accounts(f),
    (s) => s.login?.status === 'error',
  );
  assert.match(status.login.message, /其他账号或工作区/);
  assert.equal(status.items.length, 1);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.bridge, 'accounts', id, 'auth.json'))),
    fresh,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'auth.json'))), live);
});

test('官方登录HTTP：进程提前退出与程序缺失均可重试且额度报真实失败', async (t) => {
  const f = await officialFixture(t, { live: auth('alice') });
  await accounts(f);
  f.update((s) => {
    s.methods['account/login/start'] = { exitCode: 7 };
  });
  await api(f, 'accountLogin', {}, 400);
  assert.equal((await accounts(f)).login.status, 'error');
  f.update((s) => {
    s.methods['account/login/start'] = {
      result: { loginId: 'fixture-login', authUrl: 'https://example.test/fixture' },
    };
  });
  await api(f, 'accountLogin', {});
  await api(f, 'accountLoginCancel', {});
  fs.renameSync(f.environment.CODEX_EXE, f.environment.CODEX_EXE + '.disabled');
  for (let i = 0; i < 2; i++) {
    await api(f, 'accountLogin', {}, 400);
    assert.equal((await accounts(f)).login.status, 'error');
  }
  const result = await api(f, 'accountQuota', { id: accountId('alice') });
  assert.equal(result.items[0].status, 'error');
  assert.equal(result.items[0].errorKind, 'runtime_error');
});

test('官方失败日志HTTP：prepare/quota/login分别保留运行时错误码并脱敏', async (t) => {
  const live = auth('alice', { exp: 1 }),
    f = await officialFixture(t, { live });
  await accounts(f);
  const id = accountId('alice');
  fs.renameSync(f.environment.CODEX_EXE, f.environment.CODEX_EXE + '.disabled');
  await api(f, 'diagnose', {});
  fs.writeFileSync(path.join(f.home, 'auth.json'), JSON.stringify(auth('other')));
  await api(f, 'accountQuota', { id });
  await api(f, 'accountLogin', { id }, 400);
  const log = fs.readFileSync(path.join(f.bridge, 'logs/switcher.log'), 'utf8');
  const events = log
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((e) => e.event === 'official.error');
  assert.deepEqual(
    events.map((e) => e.op),
    ['prepare', 'quota', 'login'],
  );
  for (const event of events) {
    assert.equal(event.account, 'al***@example.test');
    assert.equal(event.kind, 'runtime_error');
    assert.equal(event.code, 'CODEX_NOT_FOUND');
  }
  assert.doesNotMatch(log, /fixture-refresh|alice/);
  assert.equal(log.includes(live.tokens.access_token), false);
});

test('官方额度HTTP：错误分类保留上次缓存、诊断不含秘密', async (t) => {
  const f = await officialFixture(t, { live: auth('alice') });
  await accounts(f);
  const id = accountId('alice');
  const success = (await api(f, 'accountQuota', { id })).items[0];
  for (const [code, message, kind] of [
    [401, 'invalid grant token=SECRET', 'auth_invalid'],
    [500, 'refresh token network connection timed out SECRET', 'network_error'],
    [-32601, 'method unavailable SECRET', 'runtime_error'],
    [500, 'unexpected SECRET', 'quota_error'],
  ]) {
    f.update((s) => {
      s.methods['account/rateLimits/read'] = { error: { code, message } };
    });
    const result = (await api(f, 'accountQuota', { id })).items[0];
    assert.equal(result.status, 'error');
    assert.equal(result.errorKind, kind);
    assert.deepEqual(result.buckets, success.buckets);
    assert.equal(result.checkedAt, success.checkedAt);
    assert.ok(result.attemptedAt);
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
  const log = fs.readFileSync(path.join(f.bridge, 'logs/switcher.log'), 'utf8');
  assert.match(log, /official.error/);
  assert.doesNotMatch(log, /SECRET|fixture-refresh/);
  assert.ok(
    f
      .rpc()
      .filter((c) => c.method === 'account/read')
      .every((c) => c.params.refreshToken === false),
  );
});

test('官方额度HTTP：同账号合并、两个共享名额、快请求独立且失败释放名额', async (t) => {
  const f = await officialFixture(t, { live: auth('slow') });
  for (const user of ['slow', 'fast', 'failed', 'queued']) {
    fs.writeFileSync(path.join(f.home, 'auth.json'), JSON.stringify(auth(user)));
    await accounts(f);
  }
  const ids = ['slow', 'fast', 'failed', 'queued'].map((u) => accountId(u));
  f.update((s) => {
    s.profiles = Object.fromEntries(
      ids.map((id, i) => [
        id,
        {
          methods: {
            'account/rateLimits/read': {
              waitFile: 'release-' + i,
              ...(i === 2
                ? { error: { code: 500, message: 'network failure' } }
                : s.methods['account/rateLimits/read']),
            },
          },
        },
      ]),
    );
  });
  const requests = ids.map((id) => api(f, 'accountQuota', { id }));
  const duplicate = api(f, 'accountQuota', { id: ids[3] });
  const started = () =>
    f
      .rpc()
      .filter((c) => c.method === 'account/rateLimits/read')
      .map((c) => path.basename(c.home));
  await until(
    async () => started(),
    (r) => r.length === 2,
  );
  assert.deepEqual(new Set(started()), new Set(ids.slice(0, 2)));
  fs.writeFileSync(path.join(f.root, 'release-1'), 'go');
  assert.equal((await requests[1]).items[0].status, 'ok');
  await until(
    async () => started(),
    (r) => r.length === 3,
  );
  assert.equal((await accounts(f)).items.find((a) => a.id === ids[0]).quota, null);
  fs.writeFileSync(path.join(f.root, 'release-2'), 'go');
  assert.equal((await requests[2]).items[0].errorKind, 'network_error');
  await until(
    async () => started(),
    (r) => r.length === 4,
  );
  fs.writeFileSync(path.join(f.root, 'release-3'), 'go');
  assert.deepEqual(await requests[3], await duplicate);
  assert.equal(started().filter((id) => id === ids[3]).length, 1);
  fs.writeFileSync(path.join(f.root, 'release-0'), 'go');
  assert.equal((await requests[0]).items[0].status, 'ok');
});

test('官方额度HTTP：当前过期及无exp旧登录暂缓、非当前过期仍只读查询', async (t) => {
  const expired = auth('bob', { exp: Math.floor(Date.now() / 1000) - 60 }),
    f = await officialFixture(t, { live: expired });
  await accounts(f);
  const bob = accountId('bob');
  assert.equal((await api(f, 'accountQuota', { id: bob })).items[0].status, 'deferred');
  const missing = auth('bob');
  const claims = JSON.parse(Buffer.from(missing.tokens.access_token.split('.')[1], 'base64url'));
  delete claims.exp;
  missing.tokens.access_token =
    'fixture.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature';
  missing.last_refresh = '2020-01-01T00:00:00Z';
  fs.writeFileSync(path.join(f.home, 'auth.json'), JSON.stringify(missing));
  fs.writeFileSync(path.join(f.bridge, 'accounts', bob, 'auth.json'), JSON.stringify(missing));
  assert.equal((await api(f, 'accountQuota', { id: bob })).items[0].status, 'deferred');
  assert.deepEqual(f.rpc(), []);
  fs.writeFileSync(path.join(f.home, 'auth.json'), JSON.stringify(auth('alice')));
  await accounts(f);
  assert.equal((await api(f, 'accountQuota', { id: bob })).items[0].status, 'ok');
  assert.deepEqual(f.rpc().find((c) => c.method === 'account/read').params, {
    refreshToken: false,
  });
});

test('官方账号后台续期：到期前两天刷新凭证并记录成功', { skip: !rustBackend }, async (t) => {
  const f = await officialFixture(t, { live: auth('alice') });
  await accounts(f);
  const id = accountId('bob'),
    old = auth('bob', { exp: Math.floor(Date.now() / 1000) + 86400 }),
    fresh = auth('bob', {
      exp: Math.floor(Date.now() / 1000) + 86400 * 30,
      refreshed: '2030-01-01T00:00:00Z',
    });
  fs.mkdirSync(path.join(f.bridge, 'accounts', id), { recursive: true });
  fs.writeFileSync(path.join(f.bridge, 'accounts', id, 'auth.json'), JSON.stringify(old));
  const rows = JSON.parse(fs.readFileSync(path.join(f.bridge, 'accounts', 'index.json')));
  rows.push({ id, email: 'bob@example.test', label: 'bob@example.test', plan: 'plus', pendingLogin: false });
  fs.writeFileSync(path.join(f.bridge, 'accounts', 'index.json'), JSON.stringify(rows));
  f.update((s) => {
    s.methods['account/read'] = { result: { account: { type: 'chatgpt' } }, auth: fresh };
  });
  assert.deepEqual(
    algorithm(t, { op: 'accountStore', home: f.home, bridge: f.bridge, method: 'renewDue' }, f.environment),
    { ok: true },
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.bridge, 'accounts', id, 'auth.json'))), fresh);
  const calls = f.rpc().filter((c) => c.method === 'account/read');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, { refreshToken: true });
  const log = fs.readFileSync(path.join(f.bridge, 'logs', 'switcher.log'), 'utf8');
  assert.match(log, /"event":"official\.renew"/);
  assert.match(log, /"status":"ok"/);
});

test('官方账号后台续期：API 模式账号可续期并同步本机 auth.json', { skip: !rustBackend }, async (t) => {
  const old = auth('alice', { exp: Math.floor(Date.now() / 1000) + 86400 });
  const f = await officialFixture(t, { live: old });
  await accounts(f);
  const id = accountId('alice');
  const fresh = auth('alice', {
    exp: Math.floor(Date.now() / 1000) + 86400 * 30,
    refreshed: '2030-01-01T00:00:00Z',
  });
  f.update((s) => {
    s.methods['account/read'] = { result: { account: { type: 'chatgpt' } }, auth: fresh };
  });
  const runRenew = () =>
    algorithm(t, { op: 'accountStore', home: f.home, bridge: f.bridge, method: 'renewDue' }, f.environment);

  assert.deepEqual(runRenew(), { ok: true });
  assert.deepEqual(f.rpc(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'auth.json'))), old);

  fs.writeFileSync(path.join(f.bridge, 'current.json'), JSON.stringify({ mode: 'api' }));
  assert.deepEqual(runRenew(), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'auth.json'))), fresh);
  assert.equal(f.rpc().filter((call) => call.method === 'account/read').length, 1);
});

test('官方账号后台续期：六种不续期情况均不启动假 Codex', { skip: !rustBackend }, async (t) => {
  const cases = [
    ['正在使用', (f, id) => id],
    ['等待登录', (f, id) => ({ pendingLogin: true })],
    ['还剩三天', (f, id) => ({ exp: Math.floor(Date.now() / 1000) + 86400 * 3 })],
    ['额度已确认失效', (f, id) => ({ quota: { errorKind: 'auth_invalid' } })],
    ['配置操作占用', (f, id) => ({ operation: { pid: process.pid } })],
    ['SSH 服务器正在使用', (f, id) => ({ remote: true })],
  ];
  for (const [label, configure] of cases) {
    await t.test(label, async (st) => {
      const f = await officialFixture(st, { live: auth('alice') });
      await accounts(f);
      let id = accountId('bob');
      let options = configure(f, id);
      if (options === id) options = { current: true };
      if (options.current) id = accountId('alice');
      const bob = auth(options.current ? 'alice' : 'bob', { exp: options.exp ?? Math.floor(Date.now() / 1000) + 86400 });
      fs.mkdirSync(path.join(f.bridge, 'accounts', id), { recursive: true });
      fs.writeFileSync(path.join(f.bridge, 'accounts', id, 'auth.json'), JSON.stringify(bob));
      const rows = JSON.parse(fs.readFileSync(path.join(f.bridge, 'accounts', 'index.json')));
      if (!options.current)
        rows.push({ id, email: 'bob@example.test', label: 'bob@example.test', plan: 'plus', pendingLogin: options.pendingLogin ?? false });
      fs.writeFileSync(path.join(f.bridge, 'accounts', 'index.json'), JSON.stringify(rows));
      if (options.current) {
        fs.writeFileSync(path.join(f.home, 'auth.json'), JSON.stringify(bob));
      } else if (options.quota) {
        fs.writeFileSync(path.join(f.bridge, 'accounts', id, 'quota.json'), JSON.stringify(options.quota));
      } else if (options.operation) {
        fs.writeFileSync(path.join(f.bridge, 'operation.lock'), JSON.stringify(options.operation));
      } else if (options.remote) {
        fs.mkdirSync(path.join(f.bridge, 'clients'), { recursive: true });
        fs.writeFileSync(
          path.join(f.bridge, 'clients', 'ssh.json'),
          JSON.stringify({
            id: 'ssh-window',
            seenAt: Date.now(),
            authority: 'ssh-remote+fixture',
            remoteType: 'ssh-remote',
            remoteAgent: { account: { id }, codexHome: '/srv/.codex', host: 'fixture', platform: 'linux', arch: 'x64', protocol: 3, agentVersion: '0.1.6' },
            companionVersion: '0.1.6',
            lastAck: {},
          }),
        );
      }
      assert.deepEqual(
        algorithm(st, { op: 'accountStore', home: f.home, bridge: f.bridge, method: 'renewDue' }, f.environment),
        { ok: true },
      );
      assert.equal(f.rpc().filter((c) => c.method === 'account/read').length, 0, label + ' ' + JSON.stringify(f.rpc()));
    });
  }
});

test('官方额度HTTP：刷新错误写入脱敏原因并将续期标为失败', { skip: !rustBackend }, async (t) => {
  const f = await officialFixture(t, { live: auth('alice') });
  await accounts(f);
  const id = accountId('bob'),
    bob = auth('bob', { exp: Math.floor(Date.now() / 1000) + 86400 });
  fs.mkdirSync(path.join(f.bridge, 'accounts', id), { recursive: true });
  fs.writeFileSync(path.join(f.bridge, 'accounts', id, 'auth.json'), JSON.stringify(bob));
  const rows = JSON.parse(fs.readFileSync(path.join(f.bridge, 'accounts', 'index.json')));
  rows.push({ id, email: 'bob@example.test', label: 'bob@example.test', plan: 'plus', pendingLogin: false });
  fs.writeFileSync(path.join(f.bridge, 'accounts', 'index.json'), JSON.stringify(rows));
  f.update((s) => {
    s.methods['account/read'] = {
      stderr: 'ERROR codex_login::auth::manager: Failed to refresh token: 测试原因',
      delayMs: 250,
      result: { account: null },
    };
  });
  assert.deepEqual(
    algorithm(t, { op: 'accountStore', home: f.home, bridge: f.bridge, method: 'renewDue' }, f.environment),
    { ok: true },
  );
  const log = fs.readFileSync(path.join(f.bridge, 'logs', 'switcher.log'), 'utf8');
  assert.match(log, /"refreshError":"测试原因"/);
  assert.match(log, /"event":"official\.renew"/);
  assert.match(log, /"status":"failed"/);
});

test('官方账号立即续期：成功续期，拒绝 Codex、SSH、失效和待应用账号', { skip: !rustBackend }, async (t) => {
  const f = await officialFixture(t, { live: auth('owner') });
  await accounts(f);
  const add = (user, extra = {}) => {
    const id = accountId(user), value = auth(user, { exp: Math.floor(Date.now() / 1000) + 86400 });
    fs.mkdirSync(path.join(f.bridge, 'accounts', id), { recursive: true });
    fs.writeFileSync(path.join(f.bridge, 'accounts', id, 'auth.json'), JSON.stringify(value));
    return { id, value, row: { id, email: user + '@example.test', label: user, plan: 'plus', pendingLogin: false, ...extra } };
  };
  const bob = add('bob'), pending = add('pending', { pendingLogin: true }),
    relogin = add('relogin'), remote = add('remote');
  fs.writeFileSync(path.join(f.bridge, 'accounts', relogin.id, 'quota.json'), JSON.stringify({ errorKind: 'auth_invalid' }));
  fs.mkdirSync(path.join(f.bridge, 'clients'), { recursive: true });
  fs.writeFileSync(path.join(f.bridge, 'clients', 'remote.json'), JSON.stringify({
    id: 'remote-window', seenAt: Date.now(), authority: 'ssh-remote+fixture', remoteType: 'ssh-remote',
    remoteAgent: { account: { id: remote.id }, codexHome: '/srv/.codex', host: 'fixture', platform: 'linux', arch: 'x64', protocol: 3, agentVersion: '0.1.6' },
    companionVersion: '0.1.6', lastAck: {},
  }));
  const rows = JSON.parse(fs.readFileSync(path.join(f.bridge, 'accounts', 'index.json')));
  rows.push(bob.row, pending.row, relogin.row, remote.row);
  fs.writeFileSync(path.join(f.bridge, 'accounts', 'index.json'), JSON.stringify(rows));
  f.update((s) => {
    s.methods['account/read'] = { result: { account: { type: 'chatgpt' } }, auth: auth('bob', { exp: Math.floor(Date.now() / 1000) + 86400 * 30, refreshed: '2030-01-01T00:00:00Z' }) };
  });
  const renewed = await api(f, 'accountRenew', { id: bob.id });
  assert.equal(renewed.items[0].status, 'ok');
  const callsBeforeRefusals = f.rpc().filter((call) => call.method === 'account/read').length;
  for (const [id, message] of [
    [accountId('owner'), /Codex/],
    [pending.id, /应用新登录/],
    [relogin.id, /重新登录/],
    [remote.id, /SSH/],
  ]) {
    await api(f, 'accountRenew', { id }, 400).then((value) => assert.match(value.error, message));
  }
  assert.equal(
    f.rpc().filter((call) => call.method === 'account/read').length,
    callsBeforeRefusals,
    'refused immediate renewals must not start the fake Codex',
  );
});

test('官方刷新stderr在关闭后分类额度和prepare错误', { skip: !rustBackend }, async (t) => {
  for (const [stderr, expected] of [
    ['Failed to refresh token: 网络错误', 'network_error'],
    ['Failed to refresh token: Please log out and sign in again.', 'auth_invalid'],
  ]) {
    await t.test(expected, async (st) => {
      const f = await officialFixture(st, { live: auth('alice') });
      await accounts(f);
      const id = accountId('bob'),
        expired = auth('bob', { exp: 1 });
      fs.mkdirSync(path.join(f.bridge, 'accounts', id), { recursive: true });
      fs.writeFileSync(path.join(f.bridge, 'accounts', id, 'auth.json'), JSON.stringify(expired));
      const rows = JSON.parse(fs.readFileSync(path.join(f.bridge, 'accounts', 'index.json')));
      rows.push({ id, email: 'bob@example.test', label: 'bob@example.test', plan: 'plus', pendingLogin: false });
      fs.writeFileSync(path.join(f.bridge, 'accounts', 'index.json'), JSON.stringify(rows));
      f.update((s) => {
        // Windows 的假 Codex 经一层程序转发 stderr，留出转发时间；真实 Codex 直接写管道。
        s.methods['account/read'] = { stderr, delayMs: 250, result: { account: null } };
      });

      const quota = await api(f, 'accountQuota', { id });
      assert.equal(quota.items[0].errorKind, expected);
      const prepare = algorithm(
        st,
        { op: 'accountStore', home: f.home, bridge: f.bridge, method: 'prepare', id },
        f.environment,
      );
      assert.equal(prepare.kind, expected);
      const log = fs.readFileSync(path.join(f.bridge, 'logs', 'switcher.log'), 'utf8');
      assert.match(log, /"op":"quota"/);
      assert.match(log, /"op":"prepare"/);
      assert.match(log, /"refreshError":"/);
      assert.ok(log.includes('"refreshError":"' + stderr.replace('Failed to refresh token: ', '') + '"'));
    });
  }
});

test('官方账号状态返回续期状态并清理残留账号目录', { skip: !rustBackend }, async (t) => {
  const f = await officialFixture(t, { live: auth('owner') });
  await accounts(f);
  const add = (user, options = {}) => {
    const id = accountId(user), value = auth(user, { exp: options.exp ?? Math.floor(Date.now() / 1000) + 86400 * 30 });
    fs.mkdirSync(path.join(f.bridge, 'accounts', id), { recursive: true });
    fs.writeFileSync(path.join(f.bridge, 'accounts', id, 'auth.json'), JSON.stringify(value));
    return { id, row: { id, email: user + '@example.test', label: user, plan: 'plus', pendingLogin: options.pendingLogin ?? false }, value };
  };
  const auto = add('auto', { exp: Math.floor(Date.now() / 1000) + 86400 * 3 });
  const retry = add('retry', { exp: Math.floor(Date.now() / 1000) + 86400 });
  const relogin = add('relogin-status');
  fs.writeFileSync(path.join(f.bridge, 'accounts', retry.id, 'quota.json'), JSON.stringify({ status: 'error' }));
  fs.writeFileSync(path.join(f.bridge, 'accounts', relogin.id, 'quota.json'), JSON.stringify({ errorKind: 'auth_invalid' }));
  const rows = JSON.parse(fs.readFileSync(path.join(f.bridge, 'accounts', 'index.json')));
  rows.push(auto.row, retry.row, relogin.row);
  fs.writeFileSync(path.join(f.bridge, 'accounts', 'index.json'), JSON.stringify(rows));
  const status = await accounts(f);
  assert.equal(status.items.find((row) => row.id === auto.id).renewal.state, 'auto');
  assert.equal(status.items.find((row) => row.id === retry.id).renewal.state, 'retry');
  assert.equal(status.items.find((row) => row.id === accountId('owner')).renewal.state, 'codex');
  assert.equal(status.items.find((row) => row.id === relogin.id).renewal.state, 'relogin');
  const loginRoot = path.join(f.bridge, 'accounts', 'login');
  fs.mkdirSync(path.join(loginRoot, 'saved'), { recursive: true });
  fs.mkdirSync(path.join(loginRoot, 'orphan'), { recursive: true });
  fs.mkdirSync(path.join(f.bridge, 'accounts', 'unknown'), { recursive: true });
  fs.mkdirSync(path.join(f.bridge, 'accounts', 'known'), { recursive: true });
  fs.writeFileSync(path.join(loginRoot, 'saved', 'auth.json'), JSON.stringify(auto.value));
  fs.writeFileSync(path.join(loginRoot, 'orphan', 'auth.json'), JSON.stringify(auth('orphan')));
  fs.writeFileSync(path.join(f.bridge, 'accounts', 'unknown', 'stale.txt'), 'stale');
  fs.writeFileSync(path.join(f.bridge, 'accounts', 'known', 'auth.json'), JSON.stringify(auto.value));
  assert.deepEqual(algorithm(t, { op: 'accountStore', home: f.home, bridge: f.bridge, method: 'cleanAccounts' }, f.environment), { ok: true });
  assert.equal(fs.existsSync(path.join(loginRoot, 'saved')), false);
  assert.equal(fs.existsSync(path.join(loginRoot, 'orphan')), true);
  assert.equal(fs.existsSync(path.join(f.bridge, 'accounts', 'unknown')), false);
  assert.equal(fs.existsSync(path.join(f.bridge, 'accounts', 'known')), true);
});

test('官方诊断HTTP：过期令牌经真实session准备，按错误类型判断且不关闭客户端', async (t) => {
  const live = auth('alice', { exp: 1 }),
    f = await officialFixture(t, { live });
  const before = fs.readFileSync(path.join(f.home, 'auth.json'), 'utf8');
  let result = await api(f, 'diagnose', {});
  assert.ok(result.findings.some((r) => r.title === '官方登录仍可用'));
  assert.ok(f.rpc().some((c) => c.method === 'account/read' && c.params.refreshToken === true));
  assert.equal(
    result.actions.some((a) => a.type === 'reauth'),
    false,
  );
  for (const [code, message, expected] of [
    [401, 'invalid grant SECRET', true],
    [500, 'network timed out SECRET', false],
    [-32601, 'unavailable SECRET', false],
    [500, 'unexpected SECRET', false],
  ]) {
    f.update((s) => {
      s.methods['account/read'] = { error: { code, message } };
    });
    result = await api(f, 'diagnose', {});
    assert.equal(
      result.actions.some((a) => a.type === 'reauth'),
      expected,
    );
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
    assert.equal(fs.readFileSync(path.join(f.home, 'auth.json'), 'utf8'), before);
  }
  const log = fs.readFileSync(path.join(f.bridge, 'logs/switcher.log'), 'utf8');
  assert.match(log, /"op":"prepare"/);
  assert.doesNotMatch(log, /SECRET|fixture-refresh/);
});

test('官方登录磁盘对照：只合并已保存同账号新凭证，本机同步尊重身份及存储方式', async (t) => {
  const { algorithm } = require('./config-blackbox-helpers.cjs');
  const live = auth('alice'),
    fresh = auth('alice', { refreshed: '2030-01-01T00:00:00Z' }),
    f = await officialFixture(t, { live });
  await accounts(f);
  const run = (method, value) =>
    algorithm(t, { op: 'accountStore', home: f.home, bridge: f.bridge, method, auth: value });
  const file = path.join(f.bridge, 'accounts', accountId('alice'), 'auth.json');
  assert.deepEqual(run('merge', live), { changed: false });
  assert.deepEqual(run('merge', fresh), { changed: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), fresh);
  assert.deepEqual(run('merge', auth('other')), { error: '账号不存在，请重新选择' });
  for (const mode of ['keyring', 'ephemeral']) {
    fs.writeFileSync(
      path.join(f.home, 'config.toml'),
      'cli_auth_credentials_store="' + mode + '"\n',
    );
    assert.deepEqual(run('syncLocal', fresh), { changed: false });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'auth.json'))), live);
  }
  fs.writeFileSync(path.join(f.home, 'config.toml'), 'cli_auth_credentials_store="file"\n');
  assert.deepEqual(run('syncLocal', auth('other', { refreshed: '2031-01-01T00:00:00Z' })), {
    changed: false,
  });
  assert.deepEqual(run('syncLocal', fresh), { changed: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'auth.json'))), fresh);
  assert.deepEqual(run('syncLocal', live), { changed: false });
  fs.writeFileSync(path.join(f.home, 'config.toml'), 'invalid=[\n');
  assert.deepEqual(run('syncLocal', auth('alice', { refreshed: '2031-01-01T00:00:00Z' })), {
    error: '本机配置无法解析，未同步登录',
  });
});

test('官方准备磁盘及RPC对照：非当前有效令牌不启动，过期真实续期且分类拒绝', async (t) => {
  const { algorithm } = require('./config-blackbox-helpers.cjs');
  const live = auth('alice'),
    f = await officialFixture(t, { live });
  await accounts(f);
  const bob = auth('bob');
  fs.writeFileSync(path.join(f.home, 'auth.json'), JSON.stringify(bob));
  await accounts(f);
  fs.writeFileSync(path.join(f.home, 'auth.json'), JSON.stringify(live));
  await accounts(f);
  const id = accountId('bob'),
    file = path.join(f.bridge, 'accounts', id, 'auth.json');
  const prepare = () =>
    algorithm(
      t,
      { op: 'accountStore', home: f.home, bridge: f.bridge, method: 'prepare', id },
      f.environment,
    );
  assert.deepEqual(prepare(), { id });
  assert.deepEqual(f.rpc(), []);
  const expired = auth('bob', { exp: 1 }),
    fresh = auth('bob', { refreshed: '2030-01-01T00:00:00Z' });
  fresh.tokens.refresh_token = 'fixture-refresh-bob-prepared';
  fs.writeFileSync(file, JSON.stringify(expired));
  f.update((s) => {
    s.methods['account/read'].auth = fresh;
  });
  assert.deepEqual(prepare(), { id });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), fresh);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'auth.json'))), live);
  assert.deepEqual(f.rpc().find((c) => c.method === 'account/read').params, { refreshToken: true });
  for (const [code, message, kind, pattern] of [
    [401, 'invalid grant SECRET', 'auth_invalid', /官方登录已失效/],
    [500, 'network timed out SECRET', 'network_error', /尚未确认登录失效/],
    [-32601, 'unavailable SECRET', 'runtime_error', /程序不可用/],
  ]) {
    fs.writeFileSync(file, JSON.stringify(expired));
    f.update((s) => {
      s.methods['account/read'] = { error: { code, message } };
    });
    const result = prepare();
    assert.equal(result.kind, kind);
    assert.match(result.error, pattern);
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), expired);
  }
});
