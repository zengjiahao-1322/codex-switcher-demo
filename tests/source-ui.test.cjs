// 前端验收：来源卡片选择、管理分页按需读取、状态卡只给结论。
const test = require('node:test'),
  assert = require('node:assert/strict');
const { runPage } = require('./fake-page.cjs');

const now = new Date().toISOString();
const api = {
  id: 'api-1',
  name: '测试 API',
  baseUrl: 'https://api.example.com/v1',
  apiMode: 'chat_completions',
  model: 'model-a',
  models: ['model-a', 'model-b'],
  inUse: false,
  hasKey: true,
};
const quota = (remainingPercent) => ({
  status: 'ok',
  checkedAt: now,
  buckets: [{ id: 'codex', name: 'Codex', windows: [{ minutes: 300, remainingPercent }] }],
});
function backend({ accounts, clients = [] } = {}) {
  return async (route) => {
    if (route === 'state')
      return {
        body: {
          current: { official: true, model: '' },
          providers: [{ id: 'official', name: '官方', baseUrl: '' }, api],
          adapter: { autostart: false, ready: true, port: 1 },
          dataDirProtection: { ok: true },
          build: { version: '0.1.3', id: 'test' },
          update: { current: { version: '0.1.3', build: 'test' }, latest: null, status: 'idle' },
        },
      };
    if (route === 'accounts')
      return {
        body: {
          items: accounts ?? [
            {
              id: 'a1',
              label: '主账号',
              email: 'a1@example.com',
              plan: 'plus',
              current: true,
              quota: quota(62),
            },
            {
              id: 'a2',
              label: '备用',
              email: 'a2@example.com',
              plan: 'pro',
              current: false,
              quota: null,
            },
          ],
          switchJob: null,
        },
      };
    if (route === 'clients')
      return { body: { home: '', clients, auxiliary: [], editors: [], connectedEditors: 0 } };
    return { body: { message: route + ' ok', items: [] } };
  };
}
const cards = (page) =>
  page.created.filter((c) => c.tag === 'button' && c.node.className === 'source-card');
// 卡片每次渲染都会重建，只看最后一轮（数量 = 账号数 + API 数）。
const lastCards = (page, count) => cards(page).slice(-count);

test('来源卡片：默认选中正在使用的账号，点 API 卡片后切换按钮发往该 API', async () => {
  const page = await runPage({ respond: backend() });
  const shown = lastCards(page, 3);
  assert.deepEqual(
    shown.map((c) => c.node.dataset.source),
    ['account:a1', 'account:a2', 'api-1'],
  );
  assert.equal(page.byId('provider').value, 'account:a1');
  assert.equal(page.byId('switch').textContent, '重新应用');
  assert.equal(page.byId('model-fields').hidden, true);
  shown[2].node.onclick();
  assert.equal(page.byId('provider').value, 'api-1');
  assert.equal(page.byId('source-title').textContent, '测试 API');
  assert.equal(page.byId('model-fields').hidden, false);
  assert.equal(page.byId('model').value, 'model-a');
  assert.equal(page.byId('switch').textContent, '切换到这里');
  page.byId('reload-editors').checked = true;
  await page.byId('switch').onclick();
  assert.deepEqual(
    page.calls('desktopSwitch').map((r) => r.body),
    [{ id: 'api-1', model: 'model-a', reloadEditors: true }],
  );
});

test('没有保存账号时显示官方登录卡片，选中后按钮引导添加账号', async () => {
  const page = await runPage({ respond: backend({ accounts: [] }) });
  const [official] = lastCards(page, 2);
  assert.equal(official.node.dataset.source, 'official');
  official.node.onclick();
  assert.equal(page.byId('switch').textContent, '添加官方账号');
});

test('状态卡显示当前账号额度，不显示进程编号', async () => {
  const page = await runPage({
    respond: backend({
      clients: [
        {
          id: 'editor-a',
          editorId: 'a',
          kind: 'editor',
          pid: 900,
          canReload: true,
          confirmed: true,
          shared: true,
        },
      ],
    }),
  });
  assert.equal(page.byId('current-quota').hidden, false);
  assert.match(page.byId('current-quota').textContent, /^62%额度剩余$/);
  assert.equal(page.byId('editor-summary').textContent, '1 个编辑器窗口会随切换自动重载。');
  assert.match(page.byId('editor-reload-hint').textContent, /PID 900/);
});

// 账号多时：正在使用的置顶、可搜索和分类筛选，行尾显示上次读到的额度（旧读数标记为旧）。
test('来源较多时置顶正在使用的账号，并支持搜索和筛选', async () => {
  const old = { ...quota(40), checkedAt: new Date(Date.now() - 3600000).toISOString() };
  const accounts = Array.from({ length: 6 }, (_, i) => ({
    id: 'a' + i,
    label: '账号' + i,
    email: 'user' + i + '@example.com',
    plan: 'plus',
    current: i === 4,
    quota: i === 4 ? quota(62) : i === 2 ? old : null,
  }));
  const page = await runPage({ respond: backend({ accounts }) });
  const rendered = () => page.created.length;
  let mark = rendered();
  const since = () =>
    page.created
      .slice(mark)
      .filter((c) => c.tag === 'button' && c.node.className === 'source-card')
      .map((c) => c.node);
  page.byId('source-search').value = '';
  page.byId('source-search').oninput();
  const all = since();
  assert.deepEqual(
    all.map((c) => c.dataset.source),
    ['account:a4', 'account:a0', 'account:a1', 'account:a2', 'account:a3', 'account:a5', 'api-1'],
  );
  assert.equal(page.byId('source-search').hidden, false);
  const sides = page.created
    .slice(mark)
    .filter((c) => c.tag === 'span' && /^side/.test(c.node.className))
    .map((c) => c.node.className);
  assert.deepEqual(sides, ['side', 'side stale'], '当前账号是新读数，账号2是一小时前的旧读数');

  mark = rendered();
  page.byId('source-search').value = 'USER3';
  page.byId('source-search').oninput();
  assert.deepEqual(
    since().map((c) => c.dataset.source),
    ['account:a3'],
  );

  mark = rendered();
  page.byId('source-search').value = '';
  page.byId('source-filter').onclick({
    target: { closest: () => ({ dataset: { filter: 'api' } }) },
  });
  assert.deepEqual(
    since().map((c) => c.dataset.source),
    ['api-1'],
  );
});

test('来源不多时不显示搜索和筛选', async () => {
  const page = await runPage({ respond: backend() });
  assert.equal(page.byId('source-search').hidden, true);
  assert.equal(page.byId('source-filter').hidden, true);
});

test('管理分页默认收起；打开时才读取数据，再点一次收起', async () => {
  const page = await runPage({ respond: backend() });
  for (const id of ['account-manager', 'api-manager', 'client-details', 'settings-panel'])
    assert.notEqual(page.byId(id).hidden, false, id + ' 首屏应收起');
  assert.equal(page.calls('accountQuota').length, 0, '首屏不批量读取其他账号额度');
  const clientsBefore = page.calls('clients').length;

  page.byId('tab-accounts').onclick();
  await page.settle();
  assert.equal(page.byId('account-manager').hidden, false);
  assert.deepEqual(
    page
      .calls('accountQuota')
      .map((r) => r.body.id)
      .sort(),
    ['a1', 'a2'],
    '有账号额度未读取或过期时，打开账号管理刷新全部额度',
  );

  page.byId('tab-editors').onclick();
  await page.settle();
  assert.equal(page.byId('account-manager').hidden, true);
  assert.equal(page.byId('client-details').hidden, false);
  assert.equal(page.calls('clients').length, clientsBefore + 1);

  page.byId('tab-editors').onclick();
  assert.equal(page.byId('client-details').hidden, true);
});
