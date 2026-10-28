'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { api } = require('./config-blackbox-helpers.cjs');
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
