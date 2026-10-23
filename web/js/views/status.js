import { $, api } from '../api.js';
import { accountData, state } from '../store.js';
import { busy, status } from '../ui.js';
import { accountRemaining, refreshAccounts, renderQuotaNotice, watchAccounts } from './accounts.js';
import { switchPending } from './sources.js';

export let progressJob = null;
export function renderSwitchProgress() {
  const job = accountData?.switchJob,
    box = $('switch-progress');
  box.hidden = !job?.steps?.length;
  if (box.hidden) return;
  const running = switchPending();
  if (progressJob !== job.startedAt) {
    progressJob = job.startedAt;
    if (running || job.status === 'error') box.open = true;
  }
  const elapsed = running ? Date.now() - Date.parse(job.startedAt) : job.elapsedMs;
  const seconds = ((elapsed || 0) / 1000).toFixed(1);
  $('switch-progress-title').textContent =
    (running ? '切换中' : job.status === 'error' ? '切换未完成' : '切换步骤已执行') +
    ' · ' +
    seconds +
    ' 秒';
  $('switch-steps').replaceChildren();
  for (const step of job.steps) {
    const line = document.createElement('p');
    line.textContent =
      (step.status === 'done' ? '✓ ' : step.status === 'error' ? '失败 · ' : '进行中 · ') +
      step.label +
      (step.durationMs == null ? '' : ' · ' + (step.durationMs / 1000).toFixed(1) + ' 秒');
    $('switch-steps').append(line);
  }
  $('switch-windows').replaceChildren();
  const threads = job.threads;
  if (job.configurationApplied) {
    const line = document.createElement('p');
    line.textContent =
      '配置已保存' +
      (job.threadFollow === 'off'
        ? ' · 旧对话保持原来源'
        : threads
          ? ' · 旧对话：已同步 ' +
            threads.updated +
            ' 条，跳过 ' +
            threads.skipped +
            ' 条' +
            (threads.failed ? '，' + threads.failed + ' 条未完成' : '')
          : '');
    $('switch-windows').append(line);
  }
  const resumable = job.status === 'error' && threads?.failed > 0;
  $('threads-resume').hidden = !resumable;
  if (resumable) $('threads-resume').textContent = '继续同步剩余 ' + threads.failed + ' 条旧对话';
  if (job.desktopRequested) {
    const line = document.createElement('p');
    line.textContent = job.desktopStarted
      ? '桌面端：已确认新主进程启动 · PID ' + job.desktopStarted.pid + '；尚未验证实际请求来源。'
      : '桌面端：已请求重新打开，尚未确认实际请求来源。';
    $('switch-windows').append(line);
  }
  const labels = {
    pending: '等待接收',
    received: '已接收，等待扩展重新连接',
    reloaded: '扩展已重载，尚未验证实际请求',
    failed: '重载失败',
    unconfirmed: '未确认，请展开客户端列表核对',
  };
  const results = job.editorReload?.results || [];
  if (results.length) {
    const summary = document.createElement('p');
    const reloaded = results.filter((w) => w.status === 'reloaded').length;
    const failed = results.filter((w) => w.status === 'failed').length;
    summary.textContent =
      '编辑器 ' +
      results.length +
      ' 个窗口：' +
      reloaded +
      ' 个扩展已重载，' +
      (results.length - reloaded - failed) +
      ' 个待确认' +
      (failed ? '，' + failed + ' 个失败' : '') +
      '。';
    $('switch-windows').append(summary);
  }
  for (const window of results) {
    const line = document.createElement('p');
    line.textContent =
      window.name +
      (window.workspace ? ' · ' + window.workspace : '') +
      '：' +
      labels[window.status] +
      (window.error ? ' · ' + window.error : '');
    $('switch-windows').append(line);
  }
}
export function renderSummary() {
  const c = state.current;
  const b = document.createElement('b'),
    kind = document.createElement('small');
  const account = accountData?.items.find((a) => a.current);
  b.textContent = c.official ? account?.label || '未登录' : c.name;
  kind.textContent = c.official
    ? 'ChatGPT 官方账号' + (account?.plan ? ' · ' + account.plan : '')
    : '自定义 API · ' + (c.model || '默认模型');
  $('summary').replaceChildren(b, kind);
  $('summary').title = state.codexVersion || '';
  // 状态卡只显示当前账号近期读取到的最低剩余比例，详细窗口在账号卡片和账号管理里。
  const remaining = c.official && account ? accountRemaining(account) : null,
    box = $('current-quota');
  box.hidden = remaining === null;
  box.replaceChildren();
  if (remaining !== null) {
    const ring = document.createElement('div'),
      value = document.createElement('b'),
      label = document.createElement('small');
    ring.className = 'ring' + (remaining > 20 ? '' : ' low');
    ring.style.setProperty('--p', remaining);
    ring.setAttribute('role', 'img');
    ring.setAttribute('aria-label', '当前账号剩余额度 ' + Math.round(remaining) + '%');
    value.textContent = Math.round(remaining) + '%';
    label.textContent = '额度剩余';
    ring.append(value, label);
    box.append(ring);
  }
  renderQuotaNotice();
}
export function renderEffect() {
  $('effect-notice').hidden = !state?.effect?.message;
  $('effect-notice').textContent = state?.effect?.message || '';
}
$('threads-resume').onclick = () =>
  busy($('threads-resume'), async () => {
    const r = await api('resumeThreadSync', {});
    status(r.message);
    accountData.switchJob = { status: 'queued' };
    watchAccounts();
    await refreshAccounts();
  });
