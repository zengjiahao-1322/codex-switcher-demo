'use strict';
// Claude Code 页的数据整理：分组、当前项和状态文字都只依据后台给出的接入方式。
const test = require('node:test');
const assert = require('node:assert/strict');

const providers = [
  { id: 'direct', name: 'Direct', model: 'direct-model', apiMode: 'anthropic_messages' },
  { id: 'adapter', name: 'Adapter', model: 'adapter-model', apiMode: 'responses' },
  { id: 'missing', name: 'Missing', model: 'missing-model', apiMode: 'responses' },
];
const access = [
  { id: 'direct', access: 'direct', reason: null },
  { id: 'adapter', access: 'adapter', reason: null },
  { id: 'missing', access: 'unavailable', reason: '缺少密钥' },
];

test('分组按后台接入方式，不可用项按协议留在原组并置灰', async () => {
  const { groups } = await import('../web/js/clients/claude/model.js');
  const result = groups({ providers: access }, providers);
  assert.deepEqual(result.map((group) => group.key), ['official', 'direct', 'adapter']);
  assert.deepEqual(result[1].items.map((item) => item.id), ['direct']);
  assert.deepEqual(result[2].items.map((item) => item.id), ['adapter', 'missing']);
  assert.equal(result[2].items[1].selectable, false);
});

test('当前项、按钮文字和状态文字', async () => {
  const { isCurrent, applyLabel, summary } = await import('../web/js/clients/claude/model.js');
  const taken = { current: { providerId: 'adapter', label: 'Adapter', model: 'main', fastModel: 'fast', access: 'adapter' } };
  assert.equal(isCurrent('adapter', taken), true);
  assert.equal(isCurrent('official', taken), false);
  assert.equal(applyLabel('adapter', taken), '重新应用');
  assert.equal(applyLabel('direct', taken), '用于 Claude Code');
  assert.equal(summary(taken).detail, '经本机转换 · 主模型 main · 快速模型 fast');
  // 被外部修改时既不是某个 API，也不是官方。
  const drifted = { current: null, drift: 'Claude Code 配置已被外部修改，请重新选择。' };
  assert.equal(isCurrent('official', drifted), false);
  assert.equal(summary(drifted).title, '配置已被外部修改');
  assert.equal(summary({ current: null, drift: null }).short, '官方登录（未接管）');
});
