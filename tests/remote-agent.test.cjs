// 远端代理：只读写服务器 CODEX_HOME 下的固定文件，状态不带密钥，写入前核对原文件。
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { createAgent, summarize } = require('../vscode-remote-agent/extension.cjs');
const { identity } = require('../src/accounts/accounts.cjs');

const SECRET = 'sk-remote-secret-123';
const original = [
  'model = "gpt-5.5"',
  'model_provider = "hermes_bridge"',
  '',
  '[model_providers.hermes_bridge]',
  'name = "Hermes"',
  'base_url = "https://api.example.com/v1"',
  `experimental_bearer_token = "${SECRET}"`,
  '',
].join('\n');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
function setup(text = original) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-remote-agent-'));
  if (text !== null) fs.writeFileSync(path.join(home, 'config.toml'), text);
  return { home, agent: createAgent({ home, version: '0.1.3' }) };
}

test('状态只给模型、provider 和 API 地址，不含密钥', () => {
  const { agent, home } = setup();
  const status = agent.status();
  assert.deepEqual(status.current, {
    model: 'gpt-5.5',
    modelProvider: 'hermes_bridge',
    baseUrl: 'https://api.example.com/v1',
  });
  assert.equal(status.codexHome, home);
  assert.equal(status.agentVersion, '0.1.3');
  assert.equal(JSON.stringify(status).includes(SECRET), false);
});

test('没有配置文件时状态为空，读取得到空文本', () => {
  const { agent } = setup(null);
  assert.equal(agent.status().configExists, false);
  assert.equal(agent.status().current, null);
  assert.deepEqual(agent.read(), { text: '', sha256: sha('') });
});

test('官方账号配置：provider 是内置 openai，没有自定义 base_url', () => {
  assert.deepEqual(summarize('model = "gpt-5.5"\nmodel_provider = "openai"\n'), {
    model: 'gpt-5.5',
    modelProvider: 'openai',
    baseUrl: null,
  });
  assert.deepEqual(summarize("model = 'x'\n[model_providers.\"p\"]\nbase_url = 'https://p/v1'\n"), {
    model: 'x',
    modelProvider: null,
    baseUrl: null,
  });
});

test('写入：校验原文件、先写模型目录、首次备份、权限 0600', () => {
  const { agent, home } = setup();
  const { sha256 } = agent.read();
  const next = original.replace('gpt-5.5', 'gpt-6.1-sol');
  const result = agent.write({ text: next, expectedSha256: sha256, catalog: '{"models":[]}' });
  assert.deepEqual(result, { ok: true, sha256: sha(next), authSha256: null });
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), next);
  assert.equal(
    fs.readFileSync(path.join(home, 'switcher-model-catalog.json'), 'utf8'),
    '{"models":[]}',
  );
  assert.equal(fs.readFileSync(path.join(home, 'config.toml.switcher-backup'), 'utf8'), original);
  if (process.platform !== 'win32') {
    for (const name of [
      'config.toml',
      'switcher-model-catalog.json',
      'config.toml.switcher-backup',
    ])
      assert.equal(fs.statSync(path.join(home, name)).mode & 0o777, 0o600, name);
  }
  // 第二次写入不覆盖最初的备份。
  agent.write({ text: original, expectedSha256: sha(next), catalog: null });
  assert.equal(fs.readFileSync(path.join(home, 'config.toml.switcher-backup'), 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), original);
  // 目录中只有这三个文件，没有遗留临时文件。
  assert.deepEqual(fs.readdirSync(home).sort(), [
    'config.toml',
    'config.toml.switcher-backup',
    'switcher-model-catalog.json',
  ]);
});

test('读取后配置被改过时拒绝写入，文件保持被改后的内容', () => {
  const { agent, home } = setup();
  const { sha256 } = agent.read();
  fs.writeFileSync(path.join(home, 'config.toml'), original + '# 用户手动改过\n');
  assert.throws(
    () => agent.write({ text: 'model = "x"\n', expectedSha256: sha256, catalog: null }),
    /被修改过/,
  );
  assert.equal(
    fs.readFileSync(path.join(home, 'config.toml'), 'utf8'),
    original + '# 用户手动改过\n',
  );
  assert.equal(fs.existsSync(path.join(home, 'config.toml.switcher-backup')), false);
});

test('不接受其他参数，不能借写入改别的文件', () => {
  const { agent, home } = setup();
  const { sha256 } = agent.read();
  for (const input of [
    { text: 'x', expectedSha256: sha256, catalog: null, file: '../../.bashrc' },
    { text: 'x', expectedSha256: sha256, catalog: null, path: '/etc/passwd' },
    { text: 1, expectedSha256: sha256, catalog: null },
    { text: 'x', catalog: null },
    { text: 'x', expectedSha256: sha256, catalog: { models: [] } },
  ])
    assert.throws(() => agent.write(input));
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), original);
});

// 假的官方登录：令牌是只含声明的 JWT，内容不是真实凭证。
const jwt = (payload) =>
  ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');
const login = (email, refresh = '2026-10-24T10:00:00Z', plan = 'team') =>
  JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: jwt({
        email,
        'https://api.openai.com/auth': {
          chatgpt_plan_type: plan,
          chatgpt_user_id: 'user-' + email,
        },
      }),
      access_token: jwt({
        'https://api.openai.com/auth': {
          chatgpt_plan_type: plan,
          chatgpt_user_id: 'user-' + email,
        },
      }),
      refresh_token: 'rt-secret-' + email,
      account_id: 'acct-' + email,
    },
    last_refresh: refresh,
  });

test('状态带登录账号摘要，编号与切换器保存账号一致，不含任何令牌', () => {
  const { agent, home } = setup();
  const text = login('team@example.com');
  fs.writeFileSync(path.join(home, 'auth.json'), text);
  const status = agent.status();
  const saved = identity(JSON.parse(text));
  assert.deepEqual(status.account, {
    id: saved.id,
    email: 'team@example.com',
    plan: saved.plan,
    lastRefresh: '2026-10-24T10:00:00Z',
  });
  const json = JSON.stringify(status);
  for (const token of Object.values(JSON.parse(text).tokens))
    assert.equal(json.includes(token), false, '状态不能带令牌');
  // API 密钥登录或没有登录文件时没有账号。
  fs.writeFileSync(path.join(home, 'auth.json'), '{"OPENAI_API_KEY":"sk-x"}');
  assert.equal(agent.status().account, null);
  fs.rmSync(path.join(home, 'auth.json'));
  assert.equal(agent.status().account, null);
});

test('同时写登录和配置：两者都核对，首次各留备份，权限 0600', () => {
  const { agent, home } = setup();
  const oldLogin = login('old@example.com');
  fs.writeFileSync(path.join(home, 'auth.json'), oldLogin);
  const next = 'model = "gpt-6.1-sol"\n',
    newLogin = login('team@example.com');
  const result = agent.write({
    text: next,
    expectedSha256: agent.read().sha256,
    catalog: null,
    auth: { text: newLogin, expectedSha256: agent.readAuth().sha256 },
  });
  assert.deepEqual(result, { ok: true, sha256: sha(next), authSha256: sha(newLogin) });
  assert.equal(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'), newLogin);
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), next);
  assert.equal(fs.readFileSync(path.join(home, 'auth.json.switcher-backup'), 'utf8'), oldLogin);
  assert.equal(fs.readFileSync(path.join(home, 'config.toml.switcher-backup'), 'utf8'), original);
  if (process.platform !== 'win32')
    for (const name of ['auth.json', 'auth.json.switcher-backup'])
      assert.equal(fs.statSync(path.join(home, name)).mode & 0o777, 0o600, name);
});

test('只写登录（同步较新的登录）：配置不动，没有登录文件时也能写入', () => {
  const { agent, home } = setup();
  const newer = login('team@example.com', '2026-10-25T00:00:00Z');
  const result = agent.write({
    text: null,
    expectedSha256: null,
    catalog: null,
    auth: { text: newer, expectedSha256: sha('') },
  });
  assert.deepEqual(result, { ok: true, sha256: null, authSha256: sha(newer) });
  assert.equal(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'), newer);
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(home, 'auth.json.switcher-backup')), false);
  assert.equal(fs.existsSync(path.join(home, 'config.toml.switcher-backup')), false);
});

test('登录在读取后被 Codex 续期过时拒绝，配置和登录都不写', () => {
  const { agent, home } = setup();
  fs.writeFileSync(path.join(home, 'auth.json'), login('team@example.com'));
  const expected = agent.readAuth().sha256,
    refreshed = login('team@example.com', '2026-10-25T00:00:00Z');
  fs.writeFileSync(path.join(home, 'auth.json'), refreshed);
  assert.throws(
    () =>
      agent.write({
        text: 'model = "x"\n',
        expectedSha256: agent.read().sha256,
        catalog: null,
        auth: { text: login('other@example.com'), expectedSha256: expected },
      }),
    /登录在读取后被修改过/,
  );
  assert.equal(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'), refreshed);
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), original);
});

test('登录参数也只接受约定字段；配置和登录都没有时拒绝', () => {
  const { agent, home } = setup();
  for (const input of [
    { text: null, expectedSha256: null, catalog: null },
    { text: null, catalog: null, auth: { text: 'x', expectedSha256: sha(''), file: '../x' } },
    { text: null, catalog: null, auth: { text: 1, expectedSha256: sha('') } },
    { text: null, catalog: null, auth: { text: 'x' } },
  ])
    assert.throws(() => agent.write(input));
  assert.equal(fs.existsSync(path.join(home, 'auth.json')), false);
});

test('服务器上还没有 ~/.codex 时创建目录后写入，不产生备份', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-remote-agent-'));
  const home = path.join(parent, '.codex'),
    agent = createAgent({ home, version: '0.1.3' });
  agent.write({ text: 'model = "m"\n', expectedSha256: sha(''), catalog: null });
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), 'model = "m"\n');
  assert.equal(fs.existsSync(path.join(home, 'config.toml.switcher-backup')), false);
});
