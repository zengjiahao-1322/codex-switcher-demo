'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { runPage } = require('./fake-page.cjs');
function pageBackend(options = {}, routes = {}) {
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
  Object.assign(state, options);
  return async (route, body) => {
    if (routes[route]) return routes[route](body);
    if (route === 'state') return { body: state };
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
    return { body: { message: route + ' ok' } };
  };
}
const untrustedFirst = (body) =>
  body.allowUntrusted
    ? { body: { message: '已保存' } }
    : { status: 400, body: { code: 'untrusted_codex', error: '该程序不在自动识别的安装目录中' } };
async function saveEnvironment(answer) {
  const prompts = [];
  const page = await runPage({
    respond: pageBackend({}, { setEnvironment: untrustedFirst }),
    confirm: (text) => (prompts.push(text), answer),
  });
  page.byId('config-home').value = 'C:\\codex-home';
  page.byId('runtime-path').value = ' D:\\tools\\codex.exe ';
  await page.byId('environment-save').onclick();
  return { page, prompts };
}
test('#1 页面用启动网址里的令牌换取会话，并立即从地址栏去掉', async () => {
  const page = await runPage({
    hash: '#launch-token',
    respond: (route) => ({ status: route === 'session' ? 204 : 500 }),
  });
  assert.deepEqual(page.history, ['/']);
  const [first, second] = page.requests;
  assert.equal(first.url, '/api/session');
  assert.equal(first.method, 'POST');
  assert.equal(first.headers.Authorization, 'Bearer launch-token');
  // 其余接口必须等会话建立后才发出，否则首个请求会因为没有 Cookie 被拒绝。
  assert.ok(second.url.startsWith('/api/') && second.url !== '/api/session');
});

test('#1 会话无效时显示重新打开的提示，不再访问主页重取凭证', async () => {
  const page = await runPage({ hash: '', respond: () => ({ status: 401 }) });
  assert.equal(page.byId('session-notice').hidden, false);
  assert.equal(page.workspace.hidden, true);
  assert.equal(page.byId('summary').textContent, '未连接本机会话');
  // 首屏三个请求同时发出；发现会话失效之后，任何操作都不应再发请求。
  const before = page.requests.length;
  assert.ok(before <= 3, '首屏请求数：' + before);
  await page.byId('threads-refresh').onclick();
  assert.equal(page.requests.length, before, '会话失效后不应继续发请求');
  assert.equal(
    page.requests.some((r) => r.url === '/'),
    false,
  );
});

test('#1 直接打开主页不建立会话', async () => {
  const page = await runPage({ hash: '', respond: () => ({ status: 401 }) });
  assert.equal(
    page.requests.some((r) => r.url === '/api/session'),
    false,
  );
  assert.deepEqual(page.history, []);
});

test('#2 自定义程序不在官方目录时，先让用户确认再保存', async () => {
  const { page, prompts } = await saveEnvironment(true);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes('D:\\tools\\codex.exe'));
  const saves = page.calls('setEnvironment');
  assert.equal(saves.length, 2);
  assert.equal(saves[0].body.allowUntrusted, undefined);
  assert.equal(saves[1].body.allowUntrusted, true);
});

test('#2 用户不确认时不保存程序路径', async () => {
  const { page } = await saveEnvironment(false);
  assert.equal(page.calls('setEnvironment').length, 1);
  assert.equal(page.byId('status').textContent, '未保存：程序路径未确认。');
});

test('#3 数据目录权限未收紧时页面明确提示', async () => {
  const failed = await runPage({
    respond: pageBackend({
      dataDirProtection: { ok: false, path: 'D:\\switcher', error: 'D:\\switcher：拒绝访问' },
    }),
  });
  assert.equal(failed.byId('protection-notice').hidden, false);
  assert.ok(failed.byId('protection-notice').textContent.includes('D:\\switcher：拒绝访问'));
  const ok = await runPage({ respond: pageBackend() });
  assert.equal(ok.byId('protection-notice').hidden, true);
});
