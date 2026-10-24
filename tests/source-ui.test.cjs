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
function backend({ accounts, clients = [], official = true } = {}) {
  return async (route) => {
    if (route === 'state')
      return {
        body: {
          current: { official, model: '' },
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
      return {
        body: { home: '', clients, auxiliary: [], editors: [], connectedEditors: 0, remotes: [] },
      };
    return { body: { message: route + ' ok', items: [] } };
  };
}
test('本机用 API 时，auth.json 里的账号标为“本机登录”并说明为何不能移除', async () => {
  const page = await runPage({ respond: backend({ official: false }) });
  const spans = page.created.filter((c) => c.tag === 'span').map((c) => c.node.textContent);
  assert.ok(spans.includes('本机登录'));
  assert.equal(spans.includes('正在使用'), false);
  assert.ok(
    page.created.some(
      (c) =>
        c.tag === 'small' &&
        c.node.textContent ===
          'a1@example.com · 本机 Codex 保存的是这个账号的登录，切换到其他官方账号后才能移除',
    ),
  );
  // 列表可能渲染多轮；每轮两个账号都有“改名”，只有另一个账号有“移除”。
  const count = (text) =>
    page.created.filter((c) => c.tag === 'button' && c.node.textContent === text).length;
  assert.equal(count('改名'), count('移除') * 2);
});

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

// 用户问“plus 怎么只有 30 天额度”：实际是会员已到期、令牌已变 free，页面要显示到期和读取时间。
test('会员已到期的账号标出到期，详情显示套餐、到期、读取和登录刷新时间', async () => {
  const hour = 3600000;
  const accounts = [
    {
      id: 'a1',
      label: 'expired@example.com',
      email: 'expired@example.com',
      plan: 'free',
      current: false,
      subscriptionUntil: new Date(Date.now() - hour).toISOString(),
      refreshedAt: new Date(Date.now() - 2 * hour).toISOString(),
      quota: quota(100),
    },
    {
      id: 'a2',
      label: 'active@example.com',
      email: 'active@example.com',
      plan: 'plus',
      current: true,
      subscriptionUntil: new Date(Date.now() + 10 * 24 * hour).toISOString(),
      quota: null,
    },
  ];
  const page = await runPage({ respond: backend({ accounts }) });
  const mark = page.created.length;
  const card = page.created.find(
    (c) => c.node.className === 'source-card' && c.node.dataset.source === 'account:a1',
  ).node;
  assert.equal(
    page.created.filter((c) => c.tag === 'span' && c.node.textContent === '会员已到期').length > 0,
    true,
  );
  const detail = page.created
    .filter((c) => c.tag === 'small' && /^ChatGPT free/.test(c.node.textContent))
    .at(-1).node;
  assert.match(detail.textContent, /^ChatGPT free · 会员已于 .+ 到期 · 刚刚读取$/);
  const active = page.created
    .filter((c) => c.tag === 'small' && /^ChatGPT plus/.test(c.node.textContent))
    .at(-1).node;
  assert.match(active.textContent, /^ChatGPT plus · 会员到期 \S+$/, '未读额度时不显示读取时间');

  card.onclick();
  const facts = page.created
    .slice(mark)
    .filter((c) => c.tag === 'dd')
    .map((c) => [c.node.textContent, c.node.className]);
  assert.equal(facts[0][0], 'free');
  assert.match(facts[1][0], /（已到期）$/);
  assert.equal(facts[1][1], 'warn');
  assert.match(facts[2][0], /（刚刚）$/);
  assert.match(facts[3][0], /（2 小时前）$/);
});

// 读取额度时官方续期了令牌（plus 到期变 free），刷新后页面要显示新套餐和时间，不必重开页面。
test('刷新额度后同步该账号的套餐、到期和登录刷新时间，不动其他账号', async () => {
  const hour = 3600000;
  let refreshed = false;
  const row = (id, plan, extra = {}) => ({
    id,
    label: id + '@example.com',
    email: id + '@example.com',
    plan,
    // 都不是当前账号：页面打开时不会自动刷新当前账号额度，干扰本测试。
    current: false,
    quota: null,
    ...extra,
  });
  const before = () => [
    row('a1', 'plus', { subscriptionUntil: new Date(Date.now() + hour).toISOString() }),
    row('a2', 'plus'),
  ];
  const after = () => [
    row('a1', 'free', {
      subscriptionUntil: new Date(Date.now() - hour).toISOString(),
      refreshedAt: new Date().toISOString(),
    }),
    row('a2', 'team'),
  ];
  const base = backend();
  const page = await runPage({
    respond: async (route, body) => {
      if (route === 'accounts')
        return { body: { items: refreshed ? after() : before(), switchJob: null } };
      if (route === 'accountQuota') {
        refreshed = true;
        return { body: { items: [{ id: body.id, ...quota(100) }] } };
      }
      return base(route, body);
    },
  });
  const card = page.created.find(
    (c) => c.node.className === 'source-card' && c.node.dataset.source === 'account:a1',
  ).node;
  card.onclick();
  const mark = page.created.length;
  const refresh = page.created
    .filter((c) => c.tag === 'button' && c.node.textContent === '刷新此账号额度')
    .at(-1).node;
  await refresh.onclick();
  await page.settle();
  const details = page.created
    .slice(mark)
    .filter((c) => c.tag === 'small' && /^ChatGPT /.test(c.node.textContent))
    .map((c) => c.node.textContent);
  assert.ok(
    details.some((t) => /^ChatGPT free · 会员已于 .+ 到期 · 刚刚读取$/.test(t)),
    details.join('\n'),
  );
  assert.ok(
    details.some((t) => t === 'ChatGPT plus'),
    '只同步刷新的账号，a2 仍是 plus：\n' + details.join('\n'),
  );
});

test('“全部刷新额度”一次读取所有已保存账号', async () => {
  const page = await runPage({ respond: backend() });
  const button = page.created
    .filter((c) => c.tag === 'button' && c.node.className === 'link')
    .at(-1).node;
  assert.equal(button.textContent, '全部刷新额度');
  await button.onclick();
  await page.settle();
  assert.deepEqual(
    page
      .calls('accountQuota')
      .map((r) => r.body.id)
      .sort(),
    ['a1', 'a2'],
  );
});

test('批量刷新额度最多同时读 3 个账号，全部读完', async () => {
  const accounts = Array.from({ length: 7 }, (_, i) => ({
    id: 'a' + i,
    label: 'a' + i + '@example.com',
    email: 'a' + i + '@example.com',
    plan: 'plus',
    current: i === 0,
    quota: null,
  }));
  let running = 0,
    peak = 0;
  const base = backend({ accounts });
  const page = await runPage({
    respond: async (route, body) => {
      if (route !== 'accountQuota') return base(route, body);
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 15));
      running--;
      return { body: { items: [{ id: body.id, ...quota(50) }] } };
    },
  });
  // 账号超过 5 个时显示搜索框；假页面里先给它一个真实的空值。
  page.byId('source-search').value = '';
  page.byId('quota-refresh').onclick();
  await page.settle();
  assert.equal(peak, 3);
  assert.equal(new Set(page.calls('accountQuota').map((r) => r.body.id)).size, 7);
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
