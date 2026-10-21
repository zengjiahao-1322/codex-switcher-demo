// 前端验收 #4：切换时询问旧对话去向、取消不改配置、部分失败后继续同步。
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { runPage } = require('./fake-page.cjs');
const { createService } = require('../src/server/service.cjs');

// 页面读取的状态来自真实 service，只替换会启动或重启客户端的接口。
function backend({ switchJob = null, desktopSwitch } = {}) {
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
      return { body: { home: '', clients: [], auxiliary: [], editors: [], connectedEditors: 0 } };
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
