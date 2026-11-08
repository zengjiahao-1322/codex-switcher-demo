'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('Claude model grouping uses backend access and labels current item', async () => {
  const { groups, isCurrent, applyLabel } = await import('../web/js/clients/claude/model.js');
  const state = { current: { providerId: 'adapter', model: 'main' }, providers: [] };
  const providers = [
    { id: 'direct', name: 'Direct', model: 'direct-model' },
    { id: 'adapter', name: 'Adapter', model: 'adapter-model' },
    { id: 'missing', name: 'Missing', model: 'missing-model' },
  ];
  const access = [
    { id: 'direct', access: 'direct', reason: null },
    { id: 'adapter', access: 'adapter', reason: null },
    { id: 'missing', access: 'unavailable', reason: '缺少密钥' },
  ];
  const result = groups({ ...state, providers: access }, providers);
  assert.deepEqual(result.map((group) => group.key), ['official', 'direct', 'adapter']);
  assert.deepEqual(result[1].items.map((item) => item.id), ['direct']);
  assert.deepEqual(result[2].items.map((item) => item.id), ['adapter', 'missing']);
  assert.equal(result[2].items[1].selectable, false);
  assert.equal(isCurrent('adapter', state), true);
  assert.equal(applyLabel('adapter', state), '重新应用');
  assert.equal(applyLabel('direct', state), '用于 Claude Code');
});
