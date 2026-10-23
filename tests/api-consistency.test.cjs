// 接口一致性：网页和验收脚本调用的每个后台接口都必须真实存在。
// 删除或改名接口时漏改调用方（例如 verify-web-entry 仍调用已删除的 setThreadFollow），本地测试就会失败，不必等到 CI。
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');

const root = path.join(__dirname, '..');
// 服务器直接处理、不经过 actions 的路由。
const serverRoutes = ['session', 'state', 'runtime'];

// 识别三种调用写法：网页的 api('名称')、脚本的 service.actions.名称、直接请求的 /api/名称。
function scan(text) {
  const found = new Set();
  for (const pattern of [/\bapi\(\s*'(\w+)'/g, /\bactions\.(\w+)\b/g, /\/api\/(\w+)/g])
    for (const m of text.matchAll(pattern)) found.add(m[1]);
  return found;
}
const calls = (file) => scan(fs.readFileSync(path.join(root, file), 'utf8'));

function knownActions() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-api-consistency-'));
  fs.mkdirSync(path.join(home, 'codex'));
  fs.writeFileSync(path.join(home, 'codex', 'config.toml'), 'model="gpt-5"\n');
  const { createService } = require('../src/server/service.cjs');
  const service = createService({
    codexHome: path.join(home, 'codex'),
    bridgeHome: path.join(home, 'bridge'),
  });
  return new Set([...Object.keys(service.actions), ...serverRoutes]);
}

test('网页与验收脚本调用的后台接口都存在', () => {
  const known = knownActions();
  const files = [
    ...fs
      .readdirSync(path.join(root, 'web', 'js'), { recursive: true })
      .filter((name) => name.endsWith('.js'))
      .map((name) => path.join('web', 'js', name)),
    ...fs
      .readdirSync(path.join(root, 'scripts'))
      .filter((name) => /^verify-.*\.cjs$|^macos-validation\.cjs$/.test(name))
      .map((name) => 'scripts/' + name),
  ];
  const missing = [];
  for (const file of files)
    for (const name of calls(file)) if (!known.has(name)) missing.push(file + ' → ' + name);
  assert.deepEqual(missing, [], '调用了不存在的接口：\n' + missing.join('\n'));
});

test('一致性检查能识别已删除的接口（自检）', () => {
  const known = knownActions();
  const found = scan(
    "await service.actions.setThreadFollow({ mode: 'all' }); await api('setThreadFollow', {});",
  );
  assert.equal(known.has('setThreadFollow'), false);
  assert.ok(found.has('setThreadFollow'), '扫描规则没有识别出 actions.setThreadFollow');
});
