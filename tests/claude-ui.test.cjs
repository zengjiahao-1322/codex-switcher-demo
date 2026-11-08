'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runPage } = require('./fake-page.cjs');

function backend(calls) {
  return async (route, body) => {
    if (route === 'state') return { body: {
      current: { official: true, model: '' },
      providers: [{ id: 'official', name: '官方' }, { id: 'adapter', name: 'Adapter', model: 'main', baseUrl: 'https://adapter.example/v1', apiMode: 'responses', hasKey: true }],
      claudeCode: {
        current: null, original: { kind: 'official', host: null }, drift: null, autostart: false,
        providers: [{ id: 'adapter', access: 'adapter', reason: null, remote: 'unavailable', remoteReason: '远程只能用 Anthropic 协议的 API', model: 'main', fastModel: null }],
      },
      adapter: { autostart: false, ready: true, port: 47831 }, dataDirProtection: { ok: true },
      build: { version: '0.1.7', id: 'fixture' }, update: { status: 'idle' },
    } };
    if (route === 'accounts') return { body: { items: [], switchJob: null } };
    if (route === 'clients') return { body: { clients: [], editors: [], remotes: [] } };
    return calls[route] ? calls[route](body) : { body: { message: route + ' ok' } };
  };
}

test('Claude view applies adapter API with fastModel and restores official', async () => {
  const calls = {};
  const page = await runPage({ respond: backend({
    claudeApply: (body) => { calls.apply = body; return { body: { message: '已应用' } }; },
    claudeRestore: (body) => { calls.restore = body; return { body: { message: '已恢复' } }; },
  }) });
  const switcher = page.created.find((entry) => entry.tag === 'button' && entry.node.dataset.client === 'claude');
  assert.ok(switcher);
  switcher.node.onclick();
  await page.settle();
  const adapter = page.created.find((entry) => entry.tag === 'button' && String(entry.node.textContent).includes('Adapter'));
  assert.ok(adapter);
  adapter.node.onclick();
  await page.settle();
  const applyButton = page.created.find((entry) => entry.tag === 'button' && entry.node.textContent === '用于 Claude Code');
  assert.ok(applyButton);
  applyButton.node.onclick();
  await page.settle();
  assert.deepEqual(calls.apply, { id: 'adapter', model: 'main' });
  const official = page.created.find((entry) => entry.tag === 'button' && String(entry.node.textContent).includes('Claude 官方登录'));
  assert.ok(official);
  official.node.onclick();
  await page.settle();
  const restore = page.created.find((entry) => entry.tag === 'button' && entry.node.textContent === '恢复接管前的配置');
  assert.ok(restore);
  restore.node.onclick();
  await page.settle();
  assert.deepEqual(calls.restore, {});
});
