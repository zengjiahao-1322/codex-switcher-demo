// 诊断日志验收（规格见 COLLAB.md“诊断日志规格”）：失败切换可追溯、脱敏、轮换、导出格式和页面导出。
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { runPage } = require('./fake-page.cjs');

const backendReady = fs.existsSync(
  path.join(__dirname, '..', 'src', 'diagnostics', 'event-log.cjs'),
);
const backend = { todo: !backendReady && '等待 GPT 实现诊断日志后端' };

function dirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-diagnostics-'));
  const codexHome = path.join(root, 'codex'),
    bridgeHome = path.join(root, 'bridge');
  fs.mkdirSync(codexHome);
  fs.mkdirSync(bridgeHome);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model="gpt-5"\n');
  return { codexHome, bridgeHome };
}
const logText = (bridgeHome) =>
  fs
    .readdirSync(path.join(bridgeHome, 'logs'))
    .map((name) => fs.readFileSync(path.join(bridgeHome, 'logs', name), 'utf8'))
    .join('\n');

test('切换在编辑器检查失败时，日志按顺序记下开始、窗口快照、失败步骤和结束', backend, async () => {
  const { codexHome, bridgeHome } = dirs();
  const { runSwitch } = require('../src/clients/desktop-account.cjs');
  const { readRecent } = require('../src/diagnostics/event-log.cjs');
  await assert.rejects(
    runSwitch(
      { id: 'fixture-account', codexHome, bridgeHome, desktopExe: null, threadFollow: 'off' },
      {
        accounts: { syncCurrent: async () => {}, prepare: async () => ({ id: 'fixture-account' }) },
        clients: async () => ({
          clients: [
            {
              kind: 'ide',
              pid: 811,
              confirmed: true,
              shared: true,
              editorId: null,
              home: codexHome,
            },
          ],
          inventory: {
            ancestry: [
              { pid: 811, parentPid: 700, name: 'codex.exe' },
              { pid: 700, parentPid: 1, name: 'Code.exe' },
            ],
          },
        }),
      },
    ),
    /未关联到编辑器窗口/,
  );
  const events = readRecent(bridgeHome, 100).filter((e) => e.job === 'fixture-account');
  const order = (name) => events.findIndex((e) => e.event === name);
  assert.ok(order('switch.start') >= 0, '缺少 switch.start');
  assert.ok(order('switch.start') < order('switch.clients'), '窗口快照应在开始之后');
  const snapshot = events[order('switch.clients')].clients;
  assert.equal(snapshot[0].pid, 811);
  assert.ok(JSON.stringify(snapshot[0].chain).includes('811:codex.exe'), '缺少进程链');
  assert.ok(JSON.stringify(snapshot[0].chain).includes('700:Code.exe'), '缺少父进程');
  const failed = events.find((e) => e.event === 'switch.step' && e.status === 'error');
  assert.equal(failed.id, 'prepare');
  assert.match(failed.error.message, /未关联到编辑器窗口/);
  assert.ok(order('switch.clients') < events.indexOf(failed));
  const end = events.find((e) => e.event === 'switch.end');
  assert.equal(end.status, 'error');
  assert.ok(events.indexOf(failed) < events.indexOf(end));
});

// 每一种秘密都放进字段名或字符串里；日志文件和导出文本都不能出现原文。
const secrets = {
  accessToken: 'AT-SECRET-0001',
  refreshToken: 'RT-SECRET-0002',
  jwt: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl',
  apiKey: 'sk-live-ABCDEFGHIJKLMNOPQRSTUV',
  bearer: 'BEARER-SECRET-0003',
  code: 'CODE-SECRET-0004',
  state: 'STATE-SECRET-0005',
};
function writeSecrets(bridgeHome) {
  require('../src/diagnostics/event-log.cjs').log(bridgeHome, 'official.error', {
    op: 'quota',
    account: 'fixture@example.test',
    kind: 'auth_invalid',
    code: 401,
    message: 'refresh failed ' + secrets.jwt + ' with ' + secrets.apiKey,
    access_token: secrets.accessToken,
    refresh_token: secrets.refreshToken,
    headers: { Authorization: 'Bearer ' + secrets.bearer },
    url: 'https://auth.openai.com/callback?code=' + secrets.code + '&state=' + secrets.state,
    home: path.join(os.homedir(), '.codex'),
  });
}
// 文本里不得出现任何秘密原文、完整邮箱和用户目录。
function assertNoSecrets(text) {
  for (const [name, value] of Object.entries(secrets))
    assert.equal(text.includes(value), false, name + ' 未脱敏');
  assert.equal(text.includes('itcribifredmo'), false, '邮箱未脱敏');
  for (const home of [os.homedir(), JSON.stringify(os.homedir()).slice(1, -1)])
    assert.equal(text.includes(home), false, '用户目录未替换为 ~');
}
// 含有该邮箱的记录里，邮箱应保留前两位和域名。
const assertMaskedEmail = (text) =>
  assert.ok(text.includes('it***@mail.com'), '邮箱应保留前两位和域名');

test('令牌、密钥、授权头、回调参数和邮箱在日志文件中都已脱敏', backend, () => {
  const { bridgeHome } = dirs();
  writeSecrets(bridgeHome);
  const text = logText(bridgeHome);
  assertNoSecrets(text);
  assertMaskedEmail(text);
});

test('导出文件名、环境头和最近 2000 行符合规格，且同样不含秘密', backend, async () => {
  const { codexHome, bridgeHome } = dirs();
  const { log } = require('../src/diagnostics/event-log.cjs');
  for (let i = 0; i < 2100; i++)
    log(bridgeHome, 'companion.state', { editor: 'w' + i, from: 'unmatched', to: 'ready' });
  // 带秘密的记录最后写入，确保它落在导出的最近 2000 行里。
  writeSecrets(bridgeHome);
  const { createService } = require('../src/server/service.cjs');
  const result = await createService({ codexHome, bridgeHome }).actions.exportDiagnostics({});
  assert.match(result.filename, /^codex-switcher-diagnostics-\d{8}-\d{6}\.txt$/);
  const [header, body] = result.text.split('\n---\n');
  assert.equal(typeof JSON.parse(header), 'object');
  const lines = body.trim().split('\n');
  assert.ok(lines.length <= 2000, '导出行数超过 2000：' + lines.length);
  assert.equal(JSON.parse(lines.at(-1)).event, 'official.error', '最后一行应是最新事件');
  assert.equal(JSON.parse(lines.at(-2)).editor, 'w2099', '应按时间顺序排列');
  assertNoSecrets(result.text);
  assertMaskedEmail(body);
});

test('日志超过 2 MiB 轮换，最多保留 3 个文件', backend, () => {
  const { bridgeHome } = dirs();
  const { log } = require('../src/diagnostics/event-log.cjs');
  const filler = 'x'.repeat(10 * 1024);
  for (let i = 0; i < 700; i++) log(bridgeHome, 'companion.state', { editor: 'w', note: filler });
  const files = fs.readdirSync(path.join(bridgeHome, 'logs'));
  assert.ok(files.length <= 3, '日志文件数：' + files.length);
  for (const name of files)
    assert.ok(
      fs.statSync(path.join(bridgeHome, 'logs', name)).size <= 2 * 1024 * 1024 + 16 * 1024,
      name,
    );
});

test('页面导出诊断日志：下载文件名来自后台，并提示内容已脱敏', async () => {
  const page = await runPage({
    respond: (route) =>
      route === 'exportDiagnostics'
        ? {
            body: { filename: 'codex-switcher-diagnostics-20261023-120000.txt', text: '{}\n---\n' },
          }
        : route === 'accounts'
          ? { body: { items: [], switchJob: null } }
          : { status: 500, body: { error: 'not needed' } },
  });
  await page.byId('diagnostics-export').onclick();
  const link = page.created.find((c) => c.tag === 'a' && c.node.download)?.node;
  assert.equal(link.download, 'codex-switcher-diagnostics-20261023-120000.txt');
  assert.match(link.href, /^blob:/);
  assert.match(page.byId('status').textContent, /已脱敏/);
});

test('切换失败时提示可以导出诊断日志', async () => {
  const failedJob = {
    status: 'error',
    message: '切换未完成：测试失败原因',
    startedAt: '2026-10-23T00:00:00.000Z',
    steps: [{ id: 'prepare', label: '准备账号登录', status: 'error', durationMs: 10 }],
  };
  // 页面状态来自真实 service；clients 会扫描本机进程，这里固定为空。
  const { codexHome, bridgeHome } = dirs();
  const service = require('../src/server/service.cjs').createService({ codexHome, bridgeHome });
  let switched = false;
  const page = await runPage({
    respond: async (route) =>
      route === 'state'
        ? { body: await service.state() }
        : route === 'accounts'
          ? { body: { items: [], switchJob: switched ? failedJob : null } }
          : route === 'clients'
            ? { body: { home: '', clients: [], auxiliary: [], connectedEditors: 0 } }
            : route === 'desktopSwitch'
              ? ((switched = true), { body: { message: '已开始切换' } })
              : { body: {} },
  });
  page.byId('provider').value = 'api-1';
  page.byId('model').value = 'model-1';
  await page.byId('switch').onclick();
  await page.settle();
  const text = page.byId('status').textContent;
  assert.match(text, /测试失败原因/);
  assert.match(text, /导出诊断日志/);
});
