'use strict';
// 前端验收：Claude Code 页的应用、出错提示、不可用项和恢复。
const test = require('node:test');
const assert = require('node:assert/strict');
const { runPage } = require('./fake-page.cjs');

const providers = [
  { id: 'official', name: '官方' },
  { id: 'adapter', name: 'Adapter', model: 'main', models: ['main'], baseUrl: 'https://adapter.example/v1', apiMode: 'responses', hasKey: true },
  { id: 'missing', name: 'Missing', model: 'gpt', baseUrl: 'https://missing.example/v1', apiMode: 'responses', hasKey: false },
];
const access = [
  { id: 'adapter', access: 'adapter', reason: null, model: 'main', fastModel: null },
  { id: 'missing', access: 'unavailable', reason: '缺少密钥', model: 'gpt', fastModel: null },
];
const notTaken = { current: null, original: null, drift: null, autostart: false, configDir: 'C:\\fixture\\.claude', providers: access };
const taken = {
  ...notTaken,
  current: { providerId: 'adapter', label: 'Adapter', model: 'main', fastModel: null, access: 'adapter' },
  original: { kind: 'official', host: null },
};

function backend(claudeCode, calls) {
  return async (route, body) => {
    if (route === 'state')
      return {
        body: {
          current: { official: true, model: '' },
          providers,
          claudeCode: claudeCode(),
          adapter: { port: 47831, ready: false, autostart: false },
          dataDirProtection: { ok: true },
          build: { version: '0.1.7', id: 'fixture' },
          update: { status: 'idle' },
        },
      };
    if (route === 'accounts') return { body: { items: [], switchJob: null } };
    if (route === 'clients') return { body: { clients: [], editors: [], remotes: [] } };
    return calls[route] ? calls[route](body) : { body: { message: route + ' ok' } };
  };
}
// Codex 列表也用 dataset.source 标记卡片；取最后创建的，即 Claude 页刚渲染的那一个。
const find = (page, test) =>
  page.created.filter((entry) => entry.tag === 'button' && test(entry.node)).at(-1);
async function openClaude(page) {
  find(page, (node) => node.dataset.client === 'claude').node.onclick();
  await page.settle();
}
async function pick(page, id) {
  find(page, (node) => node.dataset.source === id).node.onclick();
  await page.settle();
}
async function click(page, text) {
  const button = page.created.filter((entry) => entry.tag === 'button' && entry.node.textContent === text).at(-1);
  assert.ok(button, '找不到按钮：' + text);
  await button.node.onclick();
  await page.settle();
}

test('应用转换类 API：发出所选模型，状态卡随之显示正在使用的配置', async () => {
  let current = notTaken;
  const calls = {};
  const page = await runPage({
    respond: backend(() => current, {
      claudeApply: (body) => {
        calls.apply = body;
        current = taken;
        return { body: { message: '已让 Claude Code 使用Adapter（main）。', needsAutostart: true } };
      },
    }),
  });
  await openClaude(page);
  await pick(page, 'adapter');
  await click(page, '用于 Claude Code');
  assert.deepEqual(calls.apply, { id: 'adapter', model: 'main' });
  assert.match(page.byId('claude-summary').textContent, /Adapter/);
  assert.match(page.byId('claude-summary').textContent, /主模型 main · 快速模型 同主模型/);
  assert.equal(page.byId('claude-eyebrow').textContent, 'Claude Code 正在使用');
  assert.match(page.byId('claude-status').textContent, /已让 Claude Code 使用Adapter/);
  assert.match(page.byId('claude-status').textContent, /开机自启没开/);
});

test('后台拒绝时在本页状态行显示原因', async () => {
  const page = await runPage({
    respond: backend(() => notTaken, {
      claudeApply: () => ({ status: 400, body: { error: '请选择 Claude Code 模型' } }),
    }),
  });
  await openClaude(page);
  await pick(page, 'adapter');
  await click(page, '用于 Claude Code');
  assert.equal(page.byId('claude-status').textContent, '失败：请选择 Claude Code 模型');
});

test('不可用的 API 置灰并显示后台给出的原因', async () => {
  const page = await runPage({ respond: backend(() => notTaken, {}) });
  await openClaude(page);
  const missing = find(page, (node) => node.dataset.source === 'missing');
  assert.equal(missing.node.disabled, true);
  assert.ok(page.created.some((entry) => entry.tag === 'span' && entry.node.className === 'tag changed' && entry.node.textContent === '缺少密钥'));
});

test('官方：未接管时不能恢复；已接管时恢复接管前的配置', async () => {
  let current = notTaken;
  let restored = 0;
  const page = await runPage({
    respond: backend(() => current, {
      claudeRestore: () => {
        restored++;
        current = notTaken;
        return { body: { message: '已恢复官方登录。登录凭据未改动。', restoredTo: 'official' } };
      },
    }),
  });
  await openClaude(page);
  const disabled = page.created.filter((entry) => entry.tag === 'button' && entry.node.textContent === '恢复接管前的配置').at(-1);
  assert.equal(disabled.node.disabled, true);
  current = taken;
  await openClaude(page);
  await pick(page, 'official');
  await click(page, '恢复接管前的配置');
  assert.equal(restored, 1);
  assert.equal(page.byId('claude-status').textContent, '已恢复官方登录。登录凭据未改动。');
});
