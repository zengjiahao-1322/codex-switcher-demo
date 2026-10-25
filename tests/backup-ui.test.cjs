// 前端验收（0.1.5）：设置里的配置备份列表与恢复。
const test = require('node:test'),
  assert = require('node:assert/strict');
const { runPage } = require('./fake-page.cjs');

function backend(calls) {
  return async (route, body) => {
    if (route === 'state')
      return {
        body: {
          current: { official: true, model: '' },
          providers: [{ id: 'official', name: '官方', baseUrl: '' }],
          adapter: { autostart: false, ready: true, port: 1 },
          dataDirProtection: { ok: true },
          build: { version: '0.1.5', id: 'test' },
          update: { current: { version: '0.1.5', build: 'test', sequence: 1 }, status: 'idle' },
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
          remotes: [],
        },
      };
    return calls[route] ? calls[route](body) : { body: { message: route + ' ok', items: [] } };
  };
}
const created = (page, tag, pred = () => true) =>
  page.created.filter((c) => c.tag === tag && pred(c.node)).map((c) => c.node);

test('打开设置读取配置备份；恢复要确认，确认后按切换流程发 restoreBackup', async () => {
  let asked = '';
  const page = await runPage({
    confirm: (text) => ((asked = text), true),
    respond: backend({
      backups: () => ({
        body: {
          items: [
            {
              id: 'b2',
              at: '2026-10-25T10:00:00Z',
              reason: 'switch',
              summary: 'Direct API · gpt-6.1-sol',
            },
          ],
        },
      }),
      restoreBackup: () => ({ body: { message: '已开始恢复' } }),
    }),
  });
  assert.equal(page.calls('backups').length, 0, '首屏不读备份');
  page.byId('tab-settings').onclick();
  await page.settle();
  assert.equal(page.calls('backups').length, 1);
  assert.ok(created(page, 'small', (n) => n.textContent === 'Direct API · gpt-6.1-sol').length);
  await created(page, 'button', (n) => n.textContent === '恢复')
    .at(-1)
    .onclick();
  await page.settle();
  assert.match(asked, /恢复前会先备份当前配置，登录的账号不变/);
  assert.deepEqual(page.calls('restoreBackup')[0].body.id, 'b2');
});
