// 前端验收 #4：切换时询问旧对话去向、取消不改配置、部分失败后继续同步。
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
      return { body: { home: '', clients, auxiliary: [], editors: [], connectedEditors: 0 } };
    if (route === 'desktopSwitch') return desktopSwitch(body);
    if (route === 'setThreadFollow') return { body: await service.actions.setThreadFollow(body) };
    return { body: { message: route + ' ok' } };
  };
}

// 未设置跟随方式时，后台先拒绝；带上用户选择后才开始切换。
const askFirst = (body) =>
  body.threadFollow
    ? { body: { message: '已开始切换' } }
    : { status: 409, body: { code: 'thread_follow_required', error: '请先选择' } };

async function clickSwitch(page) {
  page.byId('provider').value = 'api-1';
  page.byId('model').value = 'model-1';
  page.byId('reload-editors').checked = true;
  let shown = 0;
  page.byId('follow-dialog').showModal = () => shown++;
  const done = page.byId('switch').onclick();
  await page.settle();
  return { done, shown: () => shown };
}

test('#4 默认先询问旧对话去向，选择并记住后带着选择重新切换', async () => {
  const page = await runPage({ respond: backend({ desktopSwitch: askFirst }) });
  assert.equal(page.byId('thread-follow').value, 'ask');
  const click = await clickSwitch(page);
  assert.equal(click.shown(), 1);
  page.byId('follow-dialog').returnValue = 'matching';
  page.byId('follow-remember').checked = true;
  page.byId('follow-dialog').onclose();
  await click.done;
  const switches = page.calls('desktopSwitch');
  assert.equal(switches.length, 2);
  assert.equal(switches[0].body.threadFollow, undefined);
  assert.deepEqual(switches[1].body, {
    id: 'api-1',
    model: 'model-1',
    reloadEditors: true,
    threadFollow: 'matching',
  });
  assert.deepEqual(page.calls('setThreadFollow')[0].body, { mode: 'matching' });
  assert.equal(page.byId('thread-follow').value, 'matching');
});

test('#4 关闭询问框即取消切换，不保存设置也不重发', async () => {
  const page = await runPage({ respond: backend({ desktopSwitch: askFirst }) });
  const click = await clickSwitch(page);
  page.byId('follow-dialog').returnValue = 'cancel';
  page.byId('follow-dialog').onclose();
  await click.done;
  assert.equal(page.calls('desktopSwitch').length, 1);
  assert.equal(page.calls('setThreadFollow').length, 0);
  assert.equal(page.byId('status').textContent, '已取消切换，配置未修改。');
});

test('#4 已设置跟随方式时直接切换，不弹出询问', async () => {
  const page = await runPage({
    respond: backend({ desktopSwitch: () => ({ body: { message: '已开始切换' } }) }),
  });
  const click = await clickSwitch(page);
  await click.done;
  assert.equal(click.shown(), 0);
  assert.equal(page.calls('desktopSwitch').length, 1);
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
  await page.byId('client-details').ontoggle();
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
  await page.byId('client-details').ontoggle();
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
  await page.byId('client-details').ontoggle();
  assert.equal(
    page.byId('editor-reload-hint').textContent,
    '1 个窗口已接入（扩展宿主 PID 900），可自动重载。',
  );
});

test('旧版伴随扩展和 Remote-SSH 未关联时给出可执行提示', async () => {
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
  await page.byId('client-details').ontoggle();
  const hint = page.byId('editor-reload-hint').textContent;
  assert.ok(hint.includes('旧版伴随扩展'), hint);
  assert.ok(hint.includes('Remote-SSH'), hint);
  // SSH 主机是 Windows / macOS 时可在该主机运行切换器；切换器没有 Linux 版，要如实说明。
  assert.ok(hint.includes('需在该主机运行同版本切换器'), hint);
  assert.ok(hint.includes('暂不支持 Linux'), hint);
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
