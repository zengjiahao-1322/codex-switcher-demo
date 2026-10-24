// 前端验收：一键升级提示、安装流程和一键更新扩展。
const test = require('node:test'),
  assert = require('node:assert/strict');
const { runPage } = require('./fake-page.cjs');

const current = { version: '0.1.3', build: 'old', sequence: 120 };
const newer = { version: '0.1.3', build: 'new', sequence: 128, notes: '修复切换失败' };
function backend(update, calls = {}) {
  return async (route) => {
    if (route === 'state')
      return {
        body: {
          current: { official: true, model: '' },
          providers: [{ id: 'official', name: '官方', baseUrl: '' }],
          adapter: { autostart: false, ready: true, port: 1 },
          dataDirProtection: { ok: true },
          build: { version: '0.1.3', id: 'old' },
          update: update(),
        },
      };
    if (route === 'accounts') return { body: { items: [], switchJob: null } };
    if (route === 'clients')
      return { body: { home: '', clients: [], auxiliary: [], editors: [], connectedEditors: 0 } };
    return calls[route]();
  };
}

test('有新构建时顶部提示，点“立即更新”后显示正在安装', async () => {
  let update = { current, latest: newer, checkedAt: new Date().toISOString(), status: 'available' };
  const page = await runPage({
    update,
    respond: backend(() => update, {
      installUpdate: () => {
        update = { ...update, status: 'installing', progress: 50 };
        return { body: { message: '更新已下载并开始安装。' } };
      },
    }),
  });
  assert.equal(page.byId('update-banner').hidden, false);
  assert.equal(page.byId('update-title').textContent, '有新版本可用');
  assert.equal(page.byId('update-detail').textContent, '0.1.3（第 128 版）\n修复切换失败');
  assert.equal(page.byId('update-install').hidden, false);
  assert.match(
    page.byId('update-status').textContent,
    /^当前第 120 版，有新版本：0\.1\.3（第 128 版） · 检查于 /,
  );

  await page.byId('update-install').onclick();
  assert.equal(page.calls('installUpdate').length, 1);
  assert.equal(page.byId('update-title').textContent, '正在安装更新');
  assert.equal(page.byId('update-install').hidden, true);
  assert.equal(page.byId('status').textContent, '更新已下载并开始安装。');
});

test('安装失败时提示原因并可重试', async () => {
  let update = { current, latest: newer, checkedAt: new Date().toISOString(), status: 'available' };
  const page = await runPage({
    update,
    respond: backend(() => update, {
      installUpdate: () => {
        update = { ...update, status: 'error', error: '更新校验和不匹配，未修改任何文件。' };
        return { status: 400, body: { error: update.error } };
      },
    }),
  });
  await page.byId('update-install').onclick();
  assert.equal(page.byId('update-title').textContent, '更新失败');
  assert.equal(page.byId('update-detail').textContent, '更新校验和不匹配，未修改任何文件。');
  assert.equal(page.byId('update-install').textContent, '重试');
});

test('已是最新或检查失败时不占用首屏，只在设置里说明', async () => {
  const latest = await runPage({
    respond: backend(() => ({ current, latest: null, status: 'idle' })),
  });
  assert.equal(latest.byId('update-banner').hidden, true);
  assert.match(latest.byId('update-status').textContent, /^已是最新版本（第 \d+ 版） · 检查于 /);

  const offline = {
    current,
    latest: null,
    checkedAt: null,
    status: 'error',
    error: '更新信息请求失败（HTTP 503）',
  };
  const failed = await runPage({ update: offline, respond: backend(() => offline) });
  assert.equal(failed.byId('update-banner').hidden, true);
  assert.equal(
    failed.byId('update-status').textContent,
    '检查或安装更新失败：更新信息请求失败（HTTP 503）',
  );
});

// 用户在开发目录里看到“有新版本”并点了更新，结果报“开发目录请用 git 更新”。
test('开发目录不提示一键升级，只在设置里说明用 git 更新', async () => {
  const dev = {
    current,
    latest: newer,
    checkedAt: new Date().toISOString(),
    status: 'idle',
    dev: true,
  };
  const page = await runPage({ update: dev, respond: backend(() => dev) });
  assert.equal(page.byId('update-banner').hidden, true);
  assert.match(
    page.byId('update-status').textContent,
    /^这是开发目录，请用 git 更新，不使用一键升级。 最新发布：0\.1\.3（第 128 版） · 检查于 /,
  );
});

test('发布说明按纯文本显示，不露出 Markdown 标题符号', async () => {
  const update = {
    current,
    latest: { ...newer, notes: '# Codex Switcher 0.1.3\n## 新功能' },
    checkedAt: new Date().toISOString(),
    status: 'available',
  };
  const page = await runPage({ update, respond: backend(() => update) });
  assert.equal(
    page.byId('update-detail').textContent,
    '0.1.3（第 128 版）\nCodex Switcher 0.1.3\n新功能',
  );
});

const companions = () => ({
  body: {
    results: [
      { name: 'VS Code', message: '已为 VS Code 安装伴随扩展。' },
      { name: 'Cursor', error: '写入失败' },
    ],
    reload: { count: 2, message: '已向 2 个编辑器窗口发送重载请求。' },
  },
});
test('一键更新扩展先确认会重载窗口，再逐个列出结果', async () => {
  let asked = '';
  const page = await runPage({
    confirm: (text) => ((asked = text), true),
    respond: backend(() => ({ current, latest: null, status: 'idle' }), {
      updateCompanions: companions,
    }),
  });
  await page.byId('companions-update').onclick();
  assert.match(asked, /重载所有已接入的编辑器窗口/);
  assert.equal(
    page.byId('status').textContent,
    '已为 VS Code 安装伴随扩展。\nCursor：失败 · 写入失败\n已向 2 个编辑器窗口发送重载请求。',
  );
});

test('不确认时不更新扩展', async () => {
  const page = await runPage({
    confirm: () => false,
    respond: backend(() => ({ current, latest: null, status: 'idle' }), {
      updateCompanions: companions,
    }),
  });
  await page.byId('companions-update').onclick();
  assert.equal(page.calls('updateCompanions').length, 0);
});

// 旧后台退出后新后台不认旧会话：提示去新页面，而不是“会话失效”。
test('升级中旧后台断开时提示使用新打开的页面', async () => {
  let update = { current, latest: newer, checkedAt: new Date().toISOString(), status: 'available' },
    gone = false;
  const respond = backend(() => update, {
    installUpdate: () => {
      gone = true;
      return { body: { message: '正在下载并校验更新。' } };
    },
  });
  const page = await runPage({
    update,
    respond: (route, body) => (gone ? { status: 401 } : respond(route, body)),
  });
  await page.byId('update-install').onclick();
  assert.equal(page.byId('session-notice').hidden, false);
  assert.match(page.byId('session-notice').textContent, /^切换器已更新，请使用新打开的页面/);
  assert.equal(page.byId('update-banner').hidden, true);
});
