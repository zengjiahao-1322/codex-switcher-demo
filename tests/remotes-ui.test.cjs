// 前端验收：远程服务器是独立分页，和本机切换互不影响；每台服务器单独选 API 并应用。
const test = require('node:test'),
  assert = require('node:assert/strict');
const { runPage } = require('./fake-page.cjs');

const group = (extra = {}) => ({
  authority: 'ssh-remote+gpu-box',
  codexHome: '/home/dev/.codex',
  host: 'gpu-box',
  platform: 'linux',
  arch: 'x64',
  agentVersion: '0.1.3',
  current: {
    model: 'gpt-5.5',
    modelProvider: 'hermes_bridge',
    baseUrl: 'https://old.example.com/v1',
  },
  windows: [
    {
      id: 'win-1',
      name: 'VS Code',
      workspace: '/srv/app',
      agentVersion: '0.1.3',
      companionVersion: '0.1.3',
    },
  ],
  ...extra,
});
const provider = (id, access, hasKey = true) => ({
  id,
  name: id,
  baseUrl: 'https://' + id + '.example.com/v1',
  apiMode: 'responses',
  model: id + '-model',
  models: [id + '-model', id + '-mini'],
  inUse: false,
  hasKey,
  access: { mode: access },
});
function backend({ remotes, providers, calls = {} }) {
  return async (route, body) => {
    if (route === 'state')
      return {
        body: {
          current: { official: true, model: '' },
          providers: [
            { id: 'official', name: '官方', baseUrl: '' },
            ...(providers ?? [
              provider('direct-api', 'direct'),
              provider('adapter-api', 'adapter'),
              provider('nokey-api', 'direct', false),
            ]),
          ],
          adapter: { autostart: false, ready: true, port: 1 },
          dataDirProtection: { ok: true },
          build: { version: '0.1.3', id: 'test' },
          update: {
            current: { version: '0.1.3', build: 'test', sequence: 1 },
            latest: null,
            status: 'idle',
          },
        },
      };
    if (route === 'accounts') return { body: { items: [], switchJob: null } };
    if (route === 'clients')
      return {
        body: {
          home: '',
          clients: [],
          auxiliary: [],
          editors: [],
          connectedEditors: 0,
          remotes: remotes(),
        },
      };
    return calls[route] ? calls[route](body) : { body: { message: route + ' ok', items: [] } };
  };
}
const created = (page, tag, pred = () => true) =>
  page.created.filter((c) => c.tag === tag && pred(c.node)).map((c) => c.node);
// 首屏 API 列表和远程列表并发返回；打开分页时刷新并画出内容。
async function openTab(page) {
  page.byId('tab-remotes').onclick();
  await page.settle();
}

test('没有远程窗口时不显示远程服务器分页', async () => {
  const page = await runPage({ respond: backend({ remotes: () => [] }) });
  assert.equal(page.byId('tab-remotes').hidden, true);
});

test('有远程窗口时显示分页和服务器数；只列可直连且有密钥的 API', async () => {
  const page = await runPage({ respond: backend({ remotes: () => [group()] }) });
  assert.equal(page.byId('tab-remotes').hidden, false);
  assert.equal(page.byId('remote-count').textContent, 1);
  await openTab(page);
  assert.equal(page.byId('remote-panel').hidden, false);
  assert.ok(
    created(
      page,
      'small',
      (n) => n.textContent === '/home/dev/.codex · 当前 old.example.com · gpt-5.5',
    ).length,
  );
  const options = created(page, 'option').map((o) => o.value);
  assert.ok(options.includes('direct-api'));
  assert.equal(options.includes('adapter-api'), false, '需要本机转换的 API 不能用于服务器');
  assert.equal(options.includes('nokey-api'), false, '没有密钥的 API 不能用于服务器');
  assert.equal(options.includes('official'), false);
});

test('应用前确认写入位置，确认后发 remoteSwitch，结果写在该服务器下', async () => {
  let asked = '';
  const page = await runPage({
    confirm: (text) => ((asked = text), true),
    respond: backend({
      remotes: () => [group()],
      calls: {
        remoteSwitch: () => ({
          body: { results: [{ codexHome: '/home/dev/.codex', status: 'synced' }] },
        }),
      },
    }),
  });
  await openTab(page);
  const model = created(page, 'input', (n) => n.value === 'direct-api-model').at(-1);
  model.value = 'direct-api-mini';
  model.oninput();
  const apply = created(page, 'button', (n) => n.textContent === '应用到这台服务器').at(-1);
  await apply.onclick();
  await page.settle();
  assert.match(asked, /把服务器 gpu-box 的 Codex 切换到「direct-api」· direct-api-mini/);
  assert.match(asked, /写入这台服务器 \/home\/dev\/\.codex 中的 config\.toml/);
  assert.match(asked, /本机不受影响/);
  assert.deepEqual(
    page.calls('remoteSwitch').map((r) => r.body),
    [{ authority: 'ssh-remote+gpu-box', providerId: 'direct-api', model: 'direct-api-mini' }],
  );
  assert.ok(
    created(page, 'p', (n) => n.textContent === '/home/dev/.codex：已写入，已请求重载窗口').length,
  );
  assert.equal(page.calls('desktopSwitch').length + page.calls('accountSwitch').length, 0);
});

test('取消确认时不发请求', async () => {
  const page = await runPage({
    confirm: () => false,
    respond: backend({ remotes: () => [group()] }),
  });
  await openTab(page);
  await created(page, 'button', (n) => n.textContent === '应用到这台服务器')
    .at(-1)
    .onclick();
  assert.equal(page.calls('remoteSwitch').length, 0);
});

test('同一服务器多个配置目录合成一张卡片，一次应用，逐目录给结果', async () => {
  let asked = '';
  const page = await runPage({
    confirm: (text) => ((asked = text), true),
    respond: backend({
      remotes: () => [group(), group({ codexHome: '/opt/codex-b', current: null })],
      calls: {
        remoteSwitch: () => ({
          body: {
            results: [
              { codexHome: '/home/dev/.codex', status: 'synced' },
              {
                codexHome: '/opt/codex-b',
                status: 'failed',
                reason: '服务器上的配置在读取后被修改过',
              },
            ],
          },
        }),
      },
    }),
  });
  await openTab(page);
  assert.equal(created(page, 'div', (n) => n.className === 'remote-card').length, 1);
  await created(page, 'button', (n) => n.textContent === '应用到这台服务器')
    .at(-1)
    .onclick();
  await page.settle();
  assert.match(asked, /\/home\/dev\/\.codex、\/opt\/codex-b/);
  assert.equal(page.calls('remoteSwitch').length, 1);
  assert.ok(
    created(
      page,
      'p',
      (n) =>
        n.textContent ===
        '/home/dev/.codex：已写入，已请求重载窗口\n/opt/codex-b：失败 · 服务器上的配置在读取后被修改过',
    ).length,
  );
});

test('没有可用于服务器的 API 时说明原因，不显示应用按钮', async () => {
  const page = await runPage({
    respond: backend({ remotes: () => [group()], providers: [provider('adapter-api', 'adapter')] }),
  });
  await openTab(page);
  assert.ok(created(page, 'small', (n) => /没有可用于服务器的 API/.test(n.textContent)).length);
  assert.equal(created(page, 'button', (n) => n.textContent === '应用到这台服务器').length, 0);
});

test('未安装或需更新远端代理时给安装按钮，不给应用', async () => {
  const page = await runPage({
    respond: backend({ remotes: () => [group({ agentVersion: null, current: null })] }),
  });
  await openTab(page);
  assert.equal(created(page, 'button', (n) => n.textContent === '应用到这台服务器').length, 0);
  await created(page, 'button', (n) => n.textContent === '安装远端代理')
    .at(-1)
    .onclick();
  assert.deepEqual(
    page.calls('installRemoteAgent').map((r) => r.body),
    [{ id: 'win-1' }],
  );

  const old = await runPage({
    respond: backend({
      remotes: () => [
        group({
          windows: [
            { id: 'win-1', name: 'VS Code', agentVersion: '0.1.2', companionVersion: '0.1.3' },
          ],
        }),
      ],
    }),
  });
  await openTab(old);
  assert.ok(created(old, 'button', (n) => n.textContent === '更新远端代理').length);
});

test('定时刷新时内容没变就不重绘，不打断正在选择的 API 和模型', async () => {
  const page = await runPage({ respond: backend({ remotes: () => [group()] }) });
  await openTab(page);
  const cards = () => created(page, 'div', (n) => n.className === 'remote-card').length;
  const before = cards();
  page.byId('tab-remotes').onclick();
  page.byId('tab-remotes').onclick();
  await page.settle();
  assert.equal(cards(), before);
});
