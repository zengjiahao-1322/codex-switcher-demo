'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {runPage}=require('./fake-page.cjs');
test('网页显示 deferred：说明文字和上次时间，不用错误样式、不显示旧额度', async () => {
  const deferred = {
    status: 'deferred',
    reason: 'token_refresh_pending',
    message:
      '当前账号的登录即将由 Codex 自己续期，为避免顶掉正在使用的登录暂不查询；Codex 刷新后会自动恢复。',
    checkedAt: '2026-10-23T10:00:00.000Z',
  };
  const page = await runPage({
    respond: (route) =>
      route === 'accounts'
        ? {
            body: {
              items: [
                {
                  id: 'a1',
                  label: 'alice',
                  email: 'alice@example.test',
                  plan: 'plus',
                  quota: deferred,
                },
              ],
              switchJob: null,
            },
          }
        : { status: 500, body: { error: 'not needed' } },
  });
  const quota = page.created.filter((c) => c.tag === 'small').map((c) => c.node);
  const texts = quota.map((n) => n.textContent);
  assert.ok(
    texts.some((x) => x.includes('即将由 Codex 自己续期')),
    texts.join(' | '),
  );
  assert.ok(texts.some((x) => x.startsWith('上次成功读取')));
  assert.equal(
    quota.some((n) => n.className === 'quota-error'),
    false,
    'deferred 不应使用错误样式',
  );
});
