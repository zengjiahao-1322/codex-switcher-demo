// 前端验收：切换直接发出（旧对话默认跟随，不再询问）、部分失败后继续同步、首屏与多窗口提示。
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { runPage } = require('./fake-page.cjs');
const { createService } = require('../src/server/service.cjs');

// 页面读取的状态来自真实 service，只替换会启动或重启客户端的接口。
function backend({ switchJob = null, desktopSwitch, clients = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-switch-ui-'));
  fs.mkdirSync(path.join(root, 'codex'));
  fs.mkdirSync(path.join(root, 'bridge'));
  fs.writeFileSync(path.join(root, 'codex', 'config.toml'), 'model="gpt-5"\n');
  const service = createService({
    codexHome: path.join(root, 'codex'),
    bridgeHome: path.join(root, 'bridge'),
  });
  return async (route, body) => {
    if (route === 'state') return { body: await service.state() };
    if (route === 'accounts') return { body: { items: [], switchJob } };
    if (route === 'clients')
      return {
        body: { home: '', clients, auxiliary: [], editors: [], connectedEditors: 0, remotes: [] },
      };
    if (route === 'desktopSwitch') return desktopSwitch(body);
    return { body: { message: route + ' ok' } };
  };
}

// 用户决定旧对话一律跟随：点击切换只发一次请求，不弹询问、不带 threadFollow，由后台默认处理。
test('切换直接发出，不询问旧对话去向', async () => {
  const page = await runPage({
    respond: backend({ desktopSwitch: () => ({ body: { message: '已开始切换' } }) }),
  });
  page.byId('provider').value = 'api-1';
  page.byId('model').value = 'model-1';
  page.byId('reload-editors').checked = true;
  await page.byId('switch').onclick();
  assert.deepEqual(
    page.calls('desktopSwitch').map((r) => r.body),
    [{ id: 'api-1', model: 'model-1', reloadEditors: true }],
  );
  assert.equal(page.calls('setThreadFollow').length, 0);
  assert.equal(page.byId('status').textContent.startsWith('已开始切换'), true);
});

test('#4 旧对话部分未同步时提供继续同步', async () => {
  const failedJob = {
    status: 'error',
    startedAt: '2026-10-21T00:00:00.000Z',
    elapsedMs: 1000,
    configurationApplied: true,
    threadFollow: 'matching',
    threads: { updated: 3, skipped: 1, failed: 2 },
    steps: [{ id: 'threads', label: '同步并核对旧对话', status: 'error', durationMs: 500 }],
  };
  const page = await runPage({ respond: backend({ switchJob: failedJob }) });
  assert.equal(page.byId('threads-resume').hidden, false);
  assert.equal(page.byId('threads-resume').textContent, '继续同步剩余 2 条旧对话');
  await page.byId('threads-resume').onclick();
  assert.equal(page.calls('resumeThreadSync').length, 1);
});

test('首屏同时发出 accounts、state、clients，不互相等待', async () => {
  let releaseAccounts;
  const accountsHeld = new Promise((resolve) => (releaseAccounts = resolve));
  const respond = backend(),
    sent = [];
  const page = runPage({
    respond: async (route, body) => {
      sent.push('/api/' + route);
      if (route === 'accounts') await accountsHeld;
      return respond(route, body);
    },
  });
  // accounts 尚未返回时，state 和 clients 必须已经发出；无论断言结果如何都放行，避免测试挂起。
  await new Promise((resolve) => setTimeout(resolve, 300));
  const before = [...sent];
  releaseAccounts();
  const loaded = await page;
  for (const route of ['/api/state', '/api/clients'])
    assert.ok(before.includes(route), route + ' 应在 accounts 返回前发出：' + before.join(','));
  assert.deepEqual(
    loaded.requests
      .slice(0, 3)
      .map((r) => r.url)
      .sort(),
    ['/api/accounts', '/api/clients', '/api/state'],
  );
});

// 失败先返回、成功后返回时（Mac CI 上实际出现的顺序），失败提示不能被覆盖。
for (const [name, slow] of [
  ['state 后返回', 'state'],
  ['accounts 后返回', 'accounts'],
]) {
  test('首屏 accounts 失败时始终显示读取失败（' + name + '）', async () => {
    const respond = backend();
    const page = await runPage({
      respond: async (route, body) => {
        if (route === slow) await new Promise((r) => setTimeout(r, 300));
        if (route === 'accounts') return { status: 500, body: { error: 'fixture load failure' } };
        return respond(route, body);
      },
    });
    assert.equal(page.byId('summary').textContent, '本机配置读取失败');
    assert.match(page.byId('status').textContent, /fixture load failure/);
  });
}

// 分别覆盖已接入、未关联、独立目录和带远程标签但未确认后端的窗口。
const editor = (id, extra = {}) => ({ id: 'editor-' + id, editorId: id, kind: 'editor', ...extra });
const backendProcess = (pid, editorId = null) => ({
  id: 'process-' + pid,
  pid,
  kind: 'ide',
  confirmed: true,
  shared: true,
  editorId,
});

test('多窗口提示区分已接入、未关联和独立配置，不凭远程标签推断归属', async () => {
  const page = await runPage({
    respond: backend({
      clients: [
        editor('a', { pid: 900, canReload: true, confirmed: true, shared: true }),
        backendProcess(11, 'a'),
        backendProcess(12),
        backendProcess(13),
        editor('ssh', { remote: 'ssh-remote+server', canReload: false }),
        editor('separate', { canReload: false, confirmed: true, shared: false }),
      ],
    }),
  });
  page.byId('tab-editors').onclick();
  await page.settle();
  const hint = page.byId('editor-reload-hint').textContent;
  assert.ok(hint.includes('1 个窗口已接入（扩展宿主 PID 900）'), hint);
  assert.ok(hint.includes('2 个共用配置的 Codex 后台（PID 12、13）没有对应到已接入的窗口'), hint);
  assert.ok(hint.includes('1 个窗口使用独立配置目录，不随本机切换'), hint);
  assert.ok(
    hint.includes('1 个窗口尚未关联到本机可见的 Codex 后端，暂不能确认是否跟随本机切换'),
    hint,
  );
  assert.equal(hint.includes('安装'), false, '原因未确认前不给安装建议');
});

// 已确认的本机后端不能被窗口的远程标签否决。
test('带远程标签但后端共用本机配置的窗口算作已接入', async () => {
  const page = await runPage({
    respond: backend({
      clients: [
        editor('a', {
          pid: 900,
          remote: 'ssh-remote+server',
          canReload: true,
          confirmed: true,
          shared: true,
        }),
        backendProcess(11, 'a'),
      ],
    }),
  });
  page.byId('tab-editors').onclick();
  await page.settle();
  assert.equal(
    page.byId('editor-reload-hint').textContent,
    '1 个窗口已接入（扩展宿主 PID 900），可自动重载。',
  );
});

test('所有后台都已接入时只显示可自动重载', async () => {
  const page = await runPage({
    respond: backend({
      clients: [
        editor('a', { pid: 900, canReload: true, confirmed: true, shared: true }),
        backendProcess(11, 'a'),
      ],
    }),
  });
  page.byId('tab-editors').onclick();
  await page.settle();
  assert.equal(
    page.byId('editor-reload-hint').textContent,
    '1 个窗口已接入（扩展宿主 PID 900），可自动重载。',
  );
});

// 朋友是经 SSH 登录到 Windows 后在该机操作；远程标签不能用来推断后端在别的主机。
test('旧版伴随扩展且带远程标签的窗口未关联时，只陈述事实，不归因到远端', async () => {
  const page = await runPage({
    respond: backend({
      clients: [
        editor('remote', {
          pid: 901,
          remote: 'ssh-remote+server',
          canReload: false,
          confirmed: false,
          reloadProtocol: 0,
        }),
        backendProcess(17632),
      ],
    }),
  });
  page.byId('tab-editors').onclick();
  await page.settle();
  const hint = page.byId('editor-reload-hint').textContent;
  assert.ok(hint.includes('旧版伴随扩展'), hint);
  assert.ok(hint.includes('1 个窗口尚未关联到本机可见的 Codex 后端'), hint);
  for (const word of ['Remote-SSH', 'SSH 主机', '远端', '同一主机'])
    assert.equal(hint.includes(word), false, '不应归因到远端：' + word);
});

test('#4 切换成功或没有失败条目时不显示继续同步', async () => {
  const page = await runPage({
    respond: backend({
      switchJob: {
        status: 'done',
        startedAt: '2026-10-21T00:00:00.000Z',
        elapsedMs: 1000,
        configurationApplied: true,
        threadFollow: 'all',
        threads: { updated: 4, skipped: 0, failed: 0 },
        steps: [{ id: 'threads', label: '同步并核对旧对话', status: 'done', durationMs: 500 }],
      },
    }),
  });
  assert.equal(page.byId('threads-resume').hidden, true);
});
