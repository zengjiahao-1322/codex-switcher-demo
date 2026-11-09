'use strict';
// 前端验收：用量分页的请求参数、汇总卡片、提示、来源表、筛选翻页、价格簿，以及 API 表单的计价设置。
const test = require('node:test');
const assert = require('node:assert/strict');
const { runPage } = require('./fake-page.cjs');

const zero = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, requests: 0 };
const providers = [
  { id: 'official', name: '官方' },
  {
    id: 'cpa', name: '小曾的CPA', baseUrl: 'http://127.0.0.1:8317/v1', apiMode: 'responses', model: 'gpt-6.1-sol',
    models: ['gpt-6.1-sol'], hasKey: true, pricing: { mode: 'official' }, usageUrl: 'http://127.0.0.1:8317/dash',
  },
  {
    id: 'relay', name: '中转站', baseUrl: 'https://relay.example/v1', apiMode: 'chat_completions', model: 'gpt-6-luna',
    models: ['gpt-6-luna'], hasKey: true, pricing: { mode: 'multiplier', multiplier: 0.3, currency: 'CNY' }, usageUrl: null,
  },
];
const summary = (over = {}) => ({
  client: 'codex',
  range: '7d',
  from: '2026-11-03T00:00:00+08:00',
  to: '2026-11-09T21:00:00+08:00',
  trackedSince: '2026-11-04T09:00:00+08:00',
  priceBook: { source: 'openrouter', fetchedAt: '2026-11-09T02:46:00Z', version: 3, error: null },
  totals: {
    input: 1000, cachedInput: 3000, cacheWrite: 0, output: 500, reasoning: 100,
    requests: 10, failed: 1, cost: { USD: 1.5, CNY: 0.25 }, priced: 8, unpriced: 2,
  },
  sources: [
    { key: 'api:cpa', kind: 'api', id: 'cpa', name: '小曾的CPA', subscription: false, usageUrl: 'http://127.0.0.1:8317/dash',
      requests: 6, failed: 1, input: 600, cachedInput: 2000, cacheWrite: 0, output: 300, reasoning: 60, cost: { USD: 1.2 } },
    { key: 'official:acc', kind: 'official', id: 'acc', name: '主账号', subscription: true, usageUrl: null,
      requests: 2, failed: 0, input: 200, cachedInput: 800, cacheWrite: 0, output: 150, reasoning: 40, cost: { USD: 0.3 } },
    { key: 'api:relay', kind: 'api', id: 'relay', name: '中转站', subscription: false, usageUrl: null,
      requests: 2, failed: 0, input: 200, cachedInput: 200, cacheWrite: 0, output: 50, reasoning: 0, cost: { CNY: 0.25 } },
  ],
  models: [
    { model: 'gpt-6.1-sol', requests: 8, failed: 1, input: 800, cachedInput: 2800, cacheWrite: 0, output: 450, reasoning: 100, cost: { USD: 1.5 }, priced: true },
    { model: 'mystery-model', requests: 2, failed: 0, input: 200, cachedInput: 200, cacheWrite: 0, output: 50, reasoning: 0, cost: {}, priced: false },
  ],
  untracked: { ...zero, requests: 3, input: 100, output: 20 },
  series: [
    { at: '2026-11-08T00:00:00+08:00', input: 400, cachedInput: 1000, cacheWrite: 0, output: 200, cost: { USD: 0.5 } },
    { at: '2026-11-09T00:00:00+08:00', input: 600, cachedInput: 2000, cacheWrite: 0, output: 300, cost: { USD: 1 } },
  ],
  ...over,
});
const row = (over = {}) => ({
  t: '2026-11-09T02:28:36Z', client: 'codex', source: { key: 'api:cpa', name: '小曾的CPA', kind: 'api' },
  model: 'gpt-6.1-sol', effort: 'medium', tier: 'default', input: 9100, cachedInput: 52100, cacheWrite: 0,
  output: 840, reasoning: 120, cost: 0.0219, currency: 'USD', ok: true, error: null, durationMs: 6100,
  project: 'HermesCodexBridge', ...over,
});

function backend(calls, usage = () => summary(), extra = {}) {
  return async (route, body) => {
    calls.push({ route, body });
    if (route === 'state')
      return {
        body: {
          current: { official: false, model: 'gpt-6.1-sol' },
          providers,
          claudeCode: { current: null, original: null, drift: null, autostart: false, configDir: 'C:\\fixture\\.claude', providers: [] },
          adapter: { port: 47831, ready: false, autostart: false },
          dataDirProtection: { ok: true },
          build: { version: '0.1.7', id: 'fixture' },
          update: { status: 'idle' },
        },
      };
    if (route === 'accounts') return { body: { items: [], switchJob: null } };
    if (route === 'clients') return { body: { clients: [], editors: [], remotes: [] } };
    if (route === 'usage') return { body: usage(body) };
    if (route === 'usageRequests') return { body: { total: 230, rows: [row(), row({ ok: false, error: '上游 HTTP 429：rate_limit_error', input: 0, cachedInput: 0, output: 0, cost: null, currency: null })] } };
    if (extra[route]) return extra[route](body);
    return { body: { message: route + ' ok' } };
  };
}
const texts = (page, tag) => page.created.filter((e) => e.tag === tag).map((e) => e.node.textContent);
const last = (calls, route) => calls.filter((c) => c.route === route).at(-1)?.body;
async function openUsage(page) {
  page.byId('tab-usage').onclick();
  await page.settle();
}

test('打开用量分页：先读汇总再读明细，卡片、提示和来源表按接口数据显示', async () => {
  const calls = [];
  const page = await runPage({ respond: backend(calls) });
  await openUsage(page);
  assert.deepEqual(last(calls, 'usage'), { client: 'codex', range: '7d' });
  assert.deepEqual(last(calls, 'usageRequests'), { client: 'codex', range: '7d', offset: 0, limit: 100 });
  // 总 token = 未缓存输入 + 缓存读 + 缓存写 + 输出
  const values = texts(page, 'b');
  assert.ok(values.includes('4.5K'), values.join('|'));
  assert.ok(values.includes('US$1.50 + ¥0.25'));
  assert.ok(values.includes('gpt-6.1-sol'));
  const hints = page.created.filter((e) => e.tag === 'p' && /hint/.test(e.node.className)).map((e) => e.node.textContent);
  assert.ok(hints.some((t) => /之前的 3 次请求/.test(t)), hints.join('|'));
  assert.ok(hints.some((t) => /有 2 次请求没找到价格（mystery-model）/.test(t)));
  const tags = texts(page, 'span');
  assert.ok(tags.includes('订阅折算'));
  assert.ok(tags.includes('0.3 倍 · 人民币'));
  const link = page.created.find((e) => e.tag === 'a' && e.node.textContent === '网关面板 ↗');
  assert.equal(link.node.href, 'http://127.0.0.1:8317/dash');
  assert.equal(page.byId('usage-pricebook').className, 'usage-book');
  assert.match(page.byId('req-range').textContent, /^1–2 \/ 230$/);
  assert.equal(page.byId('req-prev').disabled, true);
  assert.equal(page.byId('req-next').disabled, false);
  assert.ok(tags.includes('上游 HTTP 429：rate_limit_error'));
});

test('切换客户端、时间范围、筛选和翻页时带上对应参数', async () => {
  const calls = [];
  const page = await runPage({ respond: backend(calls) });
  await openUsage(page);
  const button = (key, value) => page.created.filter((e) => e.tag === 'button' && e.node.dataset[key] === value).at(-1).node;
  button('usageClient', 'claude').onclick();
  await page.settle();
  assert.deepEqual(last(calls, 'usage'), { client: 'claude', range: '7d' });
  button('usageRange', 'today').onclick();
  await page.settle();
  assert.deepEqual(last(calls, 'usage'), { client: 'claude', range: 'today' });
  page.byId('req-source').value = 'api:cpa';
  page.byId('req-source').onchange();
  await page.settle();
  assert.deepEqual(last(calls, 'usageRequests'), { client: 'claude', range: 'today', offset: 0, limit: 100, source: 'api:cpa' });
  page.byId('req-next').onclick();
  await page.settle();
  assert.deepEqual(last(calls, 'usageRequests'), { client: 'claude', range: 'today', offset: 100, limit: 100, source: 'api:cpa' });
});

test('还没有记录时显示空状态，不再读明细', async () => {
  const calls = [];
  const empty = summary({ totals: { ...zero, failed: 0, cost: {}, priced: 0, unpriced: 0 }, sources: [], models: [], untracked: zero, series: [] });
  const page = await runPage({ respond: backend(calls, () => empty) });
  await openUsage(page);
  assert.equal(page.byId('usage-empty').hidden, false);
  assert.match(page.byId('usage-empty').textContent, /还没有 Codex 用量记录/);
  assert.equal(page.byId('usage-content').hidden, true);
  assert.equal(calls.filter((c) => c.route === 'usageRequests').length, 0);
});

test('更新价格后重新读取；价格簿拉取失败时提示继续用旧价格簿', async () => {
  const calls = [];
  let book = summary().priceBook;
  const page = await runPage({
    respond: backend(calls, () => summary({ priceBook: book }), {
      usagePrices: () => {
        book = { ...book, error: '连不上 openrouter.ai' };
        return { body: { priceBook: book } };
      },
    }),
  });
  await openUsage(page);
  const before = calls.filter((c) => c.route === 'usage').length;
  await page.byId('usage-prices').onclick();
  await page.settle();
  assert.equal(calls.filter((c) => c.route === 'usagePrices').length, 1);
  assert.equal(calls.filter((c) => c.route === 'usage').length, before + 1);
  assert.equal(page.byId('usage-pricebook').className, 'usage-book warn');
  assert.match(page.byId('usage-pricebook').textContent, /价格更新失败（连不上 openrouter.ai），继续用 .* 的价格簿/);
});

test('API 表单：编辑时回填计价设置，保存时带上计价方式和用量面板地址', async () => {
  const calls = [];
  const page = await runPage({ respond: backend(calls) });
  const edit = page.created.filter((e) => e.tag === 'button' && e.node.textContent === '编辑');
  await edit[1].node.onclick();
  await page.settle();
  assert.equal(page.byId('pf-pricing').value, 'multiplier');
  assert.equal(page.byId('pf-multiplier').value, '0.3');
  assert.equal(page.byId('pf-currency').value, 'CNY');
  assert.equal(page.byId('pf-multiplier-row').hidden, false);
  page.byId('pf-usage-url').value = ' https://relay.example/usage ';
  page.byId('provider-form').onsubmit({ preventDefault() {} });
  await page.settle();
  const body = last(calls, 'providerUpdate');
  assert.equal(body.id, 'relay');
  assert.deepEqual(body.pricing, { mode: 'multiplier', multiplier: 0.3, currency: 'CNY' });
  assert.equal(body.usageUrl, 'https://relay.example/usage');
});
