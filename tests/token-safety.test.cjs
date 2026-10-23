// 当前账号令牌保护验收（规格见 COLLAB.md）：查当前账号额度时，切换器不得刷新它的令牌。
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { spawn } = require('node:child_process');
const { runPage } = require('./fake-page.cjs');

const backendReady = fs
  .readFileSync(path.join(__dirname, '..', 'src', 'accounts', 'quota-reader.cjs'), 'utf8')
  .includes('deferred');
const backend = { todo: !backendReady && '等待 GPT 实现 T' };

const jwt = (payload) =>
  'fixture.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.signature';
function auth(user, exp) {
  return {
    auth_mode: 'chatgpt',
    tokens: {
      account_id: 'workspace-' + user,
      access_token: jwt({
        exp,
        'https://api.openai.com/auth': { chatgpt_user_id: user, chatgpt_plan_type: 'plus' },
      }),
      id_token: jwt({ email: user + '@example.test' }),
      refresh_token: 'refresh-' + user,
    },
    last_refresh: new Date().toISOString(),
  };
}
const now = () => Math.floor(Date.now() / 1000);

// 假的官方 app-server：只回答额度读取需要的三个请求，并记录被启动的次数。
function accountsWith(t, liveAuth) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-token-safety-'));
  const codexHome = path.join(root, 'codex'),
    bridgeHome = path.join(root, 'bridge');
  fs.mkdirSync(codexHome);
  fs.mkdirSync(bridgeHome);
  const { createAccounts, writeJson } = require('../src/accounts/accounts.cjs');
  writeJson(path.join(codexHome, 'auth.json'), liveAuth);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model="gpt-5"\n');
  const fake = path.join(root, 'fake-app-server.cjs');
  fs.writeFileSync(
    fake,
    `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line), send = (x) => process.stdout.write(JSON.stringify(x) + '\\n');
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  if (m.method === 'account/read') send({ id: m.id, result: { account: { type: 'chatgpt' } } });
  if (m.method === 'account/rateLimits/read')
    send({ id: m.id, result: { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } } });
});`,
  );
  const launches = [],
    children = [];
  // 会话结束时子进程常被信号终止（exitCode 仍为 null），所以在启动时就记下 close，清理时只等它。
  t.after(async () => {
    await Promise.all(
      children.map(async ({ child, closed }) => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed;
      }),
    );
    fs.rmSync(root, { recursive: true, force: true });
  });
  const accounts = createAccounts({
    codexHome,
    bridgeHome,
    codexExe: process.execPath,
    spawnProcess: (_exe, args, options) => {
      launches.push(options.cwd);
      const child = spawn(process.execPath, [fake, ...args], options);
      children.push({ child, closed: new Promise((resolve) => child.once('close', resolve)) });
      return child;
    },
  });
  return { accounts, launches, codexHome, writeJson };
}

test('当前账号的访问令牌已过期：返回 deferred，不启动官方 app-server', backend, async (t) => {
  const { accounts, launches } = accountsWith(t, auth('alice', now() - 60));
  const id = accounts.status().items[0].id;
  const r = await accounts.quota(id);
  assert.equal(r.status, 'deferred');
  assert.equal(launches.length, 0, '不应启动 app-server');
});

test('当前账号的访问令牌 5 分钟内过期：同样暂不查询', backend, async (t) => {
  const { accounts, launches } = accountsWith(t, auth('alice', now() + 120));
  const id = accounts.status().items[0].id;
  assert.equal((await accounts.quota(id)).status, 'deferred');
  assert.equal(launches.length, 0);
});

test('当前账号的令牌有效：照常查询额度', backend, async (t) => {
  const { accounts, launches } = accountsWith(t, auth('alice', now() + 3600));
  const id = accounts.status().items[0].id;
  const r = await accounts.quota(id);
  assert.equal(r.status, 'ok');
  assert.equal(launches.length, 1);
});

test('非当前账号的令牌过期：行为不变，照常启动查询', backend, async (t) => {
  const { accounts, launches, codexHome, writeJson } = accountsWith(t, auth('bob', now() - 60));
  const bobId = accounts.status().items[0].id;
  // 切到 alice 后，bob 不再是当前账号。
  writeJson(path.join(codexHome, 'auth.json'), auth('alice', now() + 3600));
  assert.notEqual(accounts.status().items.find((a) => a.current).id, bobId, 'bob 应已不是当前账号');
  await accounts.quota(bobId);
  assert.equal(launches.length, 1, '非当前账号应照常启动 app-server');
});

test('网页显示 deferred：说明文字和上次时间，不用错误样式、不显示旧额度', async () => {
  const deferred = {
    status: 'deferred',
    reason: 'token_refresh_pending',
    message:
      '当前账号的登录即将由 Codex 自己续期，为避免顶掉正在使用的登录暂不查询；Codex 刷新后会自动恢复。',
    checkedAt: '2026-10-23T10:00:00.000Z',
  };
  const page = await runPage({
    respond: (route) =>
      route === 'accounts'
        ? {
            body: {
              items: [
                {
                  id: 'a1',
                  label: 'alice',
                  email: 'alice@example.test',
                  plan: 'plus',
                  quota: deferred,
                },
              ],
              switchJob: null,
            },
          }
        : { status: 500, body: { error: 'not needed' } },
  });
  const quota = page.created.filter((c) => c.tag === 'small').map((c) => c.node);
  const texts = quota.map((n) => n.textContent);
  assert.ok(
    texts.some((x) => x.includes('即将由 Codex 自己续期')),
    texts.join(' | '),
  );
  assert.ok(texts.some((x) => x.startsWith('上次成功读取')));
  assert.equal(
    quota.some((n) => n.className === 'quota-error'),
    false,
    'deferred 不应使用错误样式',
  );
});
