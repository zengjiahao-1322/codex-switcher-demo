// 前端验收：远程服务器是独立分页，顶部服务器标签，每台一张切换卡；
// 账号和 API 与本机共用同一份列表，经本机转换的 API 不能选；每台服务器单独应用。
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
  agentProtocol: 2,
  current: {
    model: 'gpt-5.5',
    modelProvider: 'hermes_bridge',
    baseUrl: 'https://old.example.com/v1',
  },
  account: null,
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
const account = (id, email, plan = 'plus') => ({
  id,
  label: email,
  email,
  plan,
  current: false,
  quota: null,
});
function backend({ remotes, providers, accounts = [], calls = {}, connectedEditors = 0 }) {
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
    if (route === 'accounts') return { body: { items: accounts, switchJob: null } };
    if (route === 'clients')
      return {
        body: {
          home: '',
          clients: [],
          auxiliary: [],
          editors: [],
          connectedEditors,
          remotes: remotes(),
        },
      };
    return calls[route] ? calls[route](body) : { body: { message: route + ' ok', items: [] } };
  };
}
const created = (page, tag, pred = () => true) =>
  page.created.filter((c) => c.tag === tag && pred(c.node)).map((c) => c.node);
const card = (page, source) => created(page, 'button', (n) => n.source === source).at(-1);
const title = (page) => created(page, 'h3').at(-1).textContent;
const applyButton = (page) =>
  created(page, 'button', (n) => n.textContent === '应用到这台服务器').at(-1);
// 首屏 API 列表和远程列表并发返回；打开分页时刷新并画出内容。再点一次是收起。
async function openTab(page) {
  page.byId('tab-remotes').onclick();
  await page.settle();
}
async function reopenTab(page) {
  page.byId('tab-remotes').onclick();
  await openTab(page);
}

test('没有远程窗口时分页照常显示，给出接入步骤和本机伴随扩展的连接情况', async () => {
  const guide = (page) =>
    created(page, 'p', (n) => /还没有检测到 Remote-SSH 窗口/.test(n.textContent)).at(-1);
  const page = await runPage({ respond: backend({ remotes: () => [] }) });
  assert.notEqual(page.byId('tab-remotes').hidden, true);
  assert.equal(page.byId('remote-count').textContent, '');
  await openTab(page);
  assert.match(guide(page).textContent, /本机还没有编辑器接入伴随扩展/);
  assert.match(guide(page).textContent, /1\. 本机 VS Code 安装伴随扩展/);

  const linked = await runPage({ respond: backend({ remotes: () => [], connectedEditors: 2 }) });
  await openTab(linked);
  assert.match(guide(linked).textContent, /本机已有 2 个编辑器窗口接入伴随扩展/);
});

test('切换卡列出全部官方账号和自定义 API；经本机转换或缺密钥的 API 显示但不能选', async () => {
  const page = await runPage({
    respond: backend({
      remotes: () => [group()],
      accounts: [account('a1', 'work@example.com'), account('a2', 'team@example.com', 'team')],
    }),
  });
  assert.equal(page.byId('remote-count').textContent, 1);
  await openTab(page);
  assert.ok(
    created(
      page,
      'small',
      (n) => n.textContent === '/home/dev/.codex · 当前 old.example.com · gpt-5.5',
    ).length,
  );
  for (const source of ['account:a1', 'account:a2', 'direct-api'])
    assert.equal(card(page, source).disabled, false, source + ' 可选');
  assert.equal(card(page, 'adapter-api').disabled, true, '需要本机转换的 API 不能用于服务器');
  assert.equal(card(page, 'nokey-api').disabled, true, '没有密钥的 API 不能用于服务器');
  assert.ok(created(page, 'small', (n) => n.textContent === '需要本机转换，服务器用不了').length);
  assert.equal(card(page, 'official'), undefined, '不出现“官方登录”占位项');
});

test('默认选中服务器正在用的来源，并标出“服务器正在使用”', async () => {
  const using = (page) => created(page, 'span', (n) => n.textContent === '服务器正在使用');
  const api = await runPage({
    respond: backend({
      remotes: () => [
        group({
          current: {
            model: 'm',
            modelProvider: 'hermes_bridge',
            baseUrl: 'https://direct-api.example.com/v1/',
          },
        }),
      ],
      accounts: [account('a1', 'work@example.com')],
    }),
  });
  await openTab(api);
  assert.equal(title(api), 'direct-api');
  assert.equal(using(api).length, 1);

  const official = await runPage({
    respond: backend({
      remotes: () => [
        group({
          current: { model: 'gpt-6.1-sol', modelProvider: null },
          account: { id: 'a2', email: 'team@example.com', plan: 'team' },
        }),
      ],
      accounts: [account('a1', 'work@example.com'), account('a2', 'team@example.com', 'team')],
    }),
  });
  await openTab(official);
  assert.equal(title(official), 'team@example.com');
  assert.ok(
    created(
      official,
      'small',
      (n) =>
        n.textContent === '/home/dev/.codex · 当前 官方 · team@example.com · team · gpt-6.1-sol',
    ).length,
  );
});

test('服务器没设 model_provider 且不是已保存账号时显示为服务器自己的登录', async () => {
  const page = await runPage({
    respond: backend({
      remotes: () => [group({ current: { model: 'gpt-6.1-sol', modelProvider: null } })],
    }),
  });
  await openTab(page);
  assert.ok(
    created(
      page,
      'small',
      (n) => n.textContent === '/home/dev/.codex · 当前 服务器自己的登录 · gpt-6.1-sol',
    ).length,
  );
});

test('选官方账号应用：确认写明登录写到服务器 auth.json，发 remoteSwitch 带 accountId', async () => {
  let asked = '';
  const page = await runPage({
    confirm: (text) => ((asked = text), true),
    respond: backend({
      remotes: () => [group()],
      accounts: [account('a1', 'work@example.com')],
      calls: {
        remoteSwitch: () => ({
          body: { results: [{ codexHome: '/home/dev/.codex', status: 'synced' }] },
        }),
      },
    }),
  });
  await openTab(page);
  card(page, 'account:a1').onclick();
  await page.settle();
  assert.equal(title(page), 'work@example.com');
  await applyButton(page).onclick();
  await page.settle();
  assert.match(asked, /把服务器 gpu-box 的 Codex 切换到官方账号「work@example\.com」/);
  assert.match(asked, /\/home\/dev\/\.codex 中的 auth\.json（只有当前用户可读）/);
  assert.match(asked, /让两边的登录保持一致/);
  assert.match(asked, /本机不受影响/);
  assert.deepEqual(
    page.calls('remoteSwitch').map((r) => r.body),
    [{ authority: 'ssh-remote+gpu-box', accountId: 'a1' }],
  );
  assert.ok(
    created(page, 'p', (n) => n.textContent === '/home/dev/.codex：已写入，已请求重载窗口').length,
  );
  assert.equal(page.calls('desktopSwitch').length + page.calls('accountSwitch').length, 0);
});

test('选 API 应用：确认写明写入位置，发 remoteSwitch 带 providerId 和模型', async () => {
  let asked = '';
  const page = await runPage({
    confirm: (text) => ((asked = text), true),
    respond: backend({
      remotes: () => [group()],
      accounts: [account('a1', 'work@example.com')],
    }),
  });
  await openTab(page);
  card(page, 'direct-api').onclick();
  await page.settle();
  const model = created(page, 'input', (n) => n.value === 'direct-api-model').at(-1);
  model.value = 'direct-api-mini';
  model.oninput();
  await applyButton(page).onclick();
  await page.settle();
  assert.match(asked, /把服务器 gpu-box 的 Codex 切换到「direct-api」· direct-api-mini/);
  assert.match(asked, /写入这台服务器 \/home\/dev\/\.codex 中的 config\.toml/);
  assert.deepEqual(
    page.calls('remoteSwitch').map((r) => r.body),
    [{ authority: 'ssh-remote+gpu-box', providerId: 'direct-api', model: 'direct-api-mini' }],
  );
});

test('取消确认时不发请求', async () => {
  const page = await runPage({
    confirm: () => false,
    respond: backend({ remotes: () => [group()] }),
  });
  await openTab(page);
  await applyButton(page).onclick();
  assert.equal(page.calls('remoteSwitch').length, 0);
});

test('多台服务器用顶部标签切换，每次只显示一台的切换卡', async () => {
  const page = await runPage({
    respond: backend({
      remotes: () => [
        group(),
        group({ authority: 'ssh-remote+lab', host: 'lab', codexHome: '/home/lab/.codex' }),
      ],
    }),
  });
  assert.equal(page.byId('remote-count').textContent, 2);
  await openTab(page);
  const tab = (name) => created(page, 'button', (n) => n.textContent === name).at(-1);
  assert.ok(tab('gpu-box') && tab('lab'));
  assert.ok(created(page, 'b', (n) => n.textContent === 'gpu-box').length);
  tab('lab').onclick();
  await page.settle();
  assert.equal(created(page, 'b').at(-1).textContent, 'lab');
  assert.ok(created(page, 'small', (n) => /^\/home\/lab\/\.codex/.test(n.textContent)).length);

  const single = await runPage({ respond: backend({ remotes: () => [group()] }) });
  await openTab(single);
  assert.equal(
    created(single, 'div', (n) => n.className === 'seg remote-servers').length,
    0,
    '只有一台时不显示服务器标签',
  );
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
  await applyButton(page).onclick();
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

test('没有能用于服务器的账号或 API 时说明原因，不显示应用按钮', async () => {
  const page = await runPage({
    respond: backend({ remotes: () => [group()], providers: [provider('adapter-api', 'adapter')] }),
  });
  await openTab(page);
  assert.ok(created(page, 'p', (n) => n.textContent === '没有能用于服务器的账号或 API。').length);
  assert.equal(applyButton(page), undefined);
});

test('未安装或需更新远端代理时给安装按钮，不给切换卡；接入后不再显示安装提示', async () => {
  let installed = false;
  const page = await runPage({
    respond: backend({
      remotes: () => [installed ? group() : group({ agentVersion: null, current: null })],
    }),
  });
  await openTab(page);
  assert.equal(applyButton(page), undefined);
  await created(page, 'button', (n) => n.textContent === '安装远端代理')
    .at(-1)
    .onclick();
  assert.deepEqual(
    page.calls('installRemoteAgent').map((r) => r.body),
    [{ id: 'win-1' }],
  );
  await page.settle();
  const notes = () => created(page, 'p', (n) => /^已安装。/.test(n.textContent)).length;
  assert.ok(notes(), '安装后提示已安装');
  const before = notes();
  installed = true;
  await reopenTab(page);
  assert.ok(applyButton(page));
  assert.equal(notes(), before, '代理接入后重绘不再带安装提示');

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

  // 同一版本号重新发布：版本相同但缺少协议号的旧代理也要提示更新。
  const sameVersion = await runPage({
    respond: backend({ remotes: () => [group({ agentProtocol: null })] }),
  });
  await openTab(sameVersion);
  assert.ok(created(sameVersion, 'button', (n) => n.textContent === '更新远端代理').length);
  assert.equal(applyButton(sameVersion), undefined);
});

test('定时刷新时内容没变就不重绘，不打断正在选择的来源和模型', async () => {
  const page = await runPage({ respond: backend({ remotes: () => [group()] }) });
  await openTab(page);
  const cards = () => created(page, 'div', (n) => n.className === 'remote-card').length;
  const before = cards();
  await reopenTab(page);
  assert.equal(cards(), before);
});
