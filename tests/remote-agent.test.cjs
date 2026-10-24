// 远端代理：只读写服务器 CODEX_HOME 下的固定文件，状态不带密钥，写入前核对原文件。
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { createAgent, summarize } = require('../vscode-remote-agent/extension.cjs');

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
  assert.deepEqual(result, { ok: true, sha256: sha(next) });
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

test('服务器上还没有 ~/.codex 时创建目录后写入，不产生备份', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-remote-agent-'));
  const home = path.join(parent, '.codex'),
    agent = createAgent({ home, version: '0.1.3' });
  agent.write({ text: 'model = "m"\n', expectedSha256: sha(''), catalog: null });
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), 'model = "m"\n');
  assert.equal(fs.existsSync(path.join(home, 'config.toml.switcher-backup')), false);
});
