'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { runPage } = require('./fake-page.cjs');
test('页面导出诊断日志：下载文件名来自后台，并提示内容已脱敏', async () => {
  const page = await runPage({
    respond: (route) =>
      route === 'exportDiagnostics'
        ? {
            body: { filename: 'codex-switcher-diagnostics-20261023-120000.txt', text: '{}\n---\n' },
          }
        : route === 'accounts'
          ? { body: { items: [], switchJob: null } }
          : { status: 500, body: { error: 'not needed' } },
  });
  await page.byId('diagnostics-export').onclick();
  const link = page.created.find((c) => c.tag === 'a' && c.node.download)?.node;
  assert.equal(link.download, 'codex-switcher-diagnostics-20261023-120000.txt');
  assert.match(link.href, /^blob:/);
  assert.match(page.byId('status').textContent, /已脱敏/);
});

test('后台是旧版本、缺少导出接口时，提示重新打开切换器', async () => {
  const page = await runPage({
    respond: (route) =>
      route === 'exportDiagnostics'
        ? { status: 404, body: { error: 'Unknown action' } }
        : route === 'accounts'
          ? { body: { items: [], switchJob: null } }
          : { status: 500, body: { error: 'not needed' } },
  });
  await page.byId('diagnostics-export').onclick();
  const text = page.byId('status').textContent;
  assert.match(text, /后台仍是更新前的版本/);
  assert.equal(text.includes('Unknown action'), false);
});

test('切换失败时提示可以导出诊断日志', async () => {
  const failedJob = {
    status: 'error',
    message: '切换未完成：测试失败原因',
    startedAt: '2026-10-23T00:00:00.000Z',
    steps: [{ id: 'prepare', label: '准备账号登录', status: 'error', durationMs: 10 }],
  };
  const state = {
    current: { official: true, model: 'gpt-5' },
    providers: [
      { id: 'official', name: '官方', baseUrl: '' },
      {
        id: 'api-1',
        name: '测试 API',
        baseUrl: 'https://api.example.com/v1',
        apiMode: 'responses',
        model: 'model-1',
        models: ['model-1'],
        hasKey: true,
      },
    ],
    adapter: { autostart: false, ready: true, port: 1 },
    dataDirProtection: { ok: true },
    build: { version: '0.1.7-rc.3', id: 'fixture' },
    update: { current: { version: '0.1.7-rc.3', build: 'fixture' }, latest: null, status: 'idle' },
  };
  let switched = false;
  const page = await runPage({
    respond: async (route) =>
      route === 'state'
        ? { body: state }
        : route === 'accounts'
          ? { body: { items: [], switchJob: switched ? failedJob : null } }
          : route === 'clients'
            ? { body: { home: '', clients: [], auxiliary: [], connectedEditors: 0, remotes: [] } }
            : route === 'desktopSwitch'
              ? ((switched = true), { body: { message: '已开始切换' } })
              : { body: {} },
  });
  page.byId('provider').value = 'api-1';
  page.byId('model').value = 'model-1';
  await page.byId('switch').onclick();
  await page.settle();
  const text = page.byId('status').textContent;
  assert.match(text, /测试失败原因/);
  assert.match(text, /导出诊断日志/);
});
