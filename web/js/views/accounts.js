import { $, api } from '../api.js';
import { refresh } from '../main.js';
import { accountData, pendingRequests, setAccountData, state } from '../store.js';
import { showTab } from '../tabs.js';
import { busy, rowButton, status, tag } from '../ui.js';
import {
  chooseSource,
  officialTarget,
  renderSelect,
  renderSources,
  selectedAccount,
  switchPending,
} from './sources.js';
import { renderSummary, renderSwitchProgress } from './status.js';

// 保存的账号只在管理区维护，所有使用操作统一到来源选择器。
export const accountStatus = (text) => {
  $('account-status').textContent = text || '';
};
export let accountTimer = null,
  lastQuotaLogin = null;
export const quotaRefreshing = new Set();
// 只使用近期成功读取、尚未重置的窗口；旧缓存和读取失败不推断为额度耗尽。
// maxAge 仅供列表展示上次读数（标为旧数据）；提醒和备用账号建议使用默认的 10 分钟。
export function accountRemaining(account, bucketId, maxAge = 600000) {
  const quota = account.quota;
  if (
    account.pendingLogin ||
    quota?.status !== 'ok' ||
    Date.now() - Date.parse(quota.checkedAt) > maxAge ||
    !Number.isFinite(Date.parse(quota.checkedAt))
  )
    return null;
  const bucket = bucketId
    ? quota.buckets?.find((b) => b.id === bucketId)
    : quota.buckets?.find((b) => b.id === 'codex') || quota.buckets?.[0];
  const windows = (bucket?.windows || []).filter(
    (w) => Number.isFinite(w.remainingPercent) && (!w.resetsAt || w.resetsAt * 1000 > Date.now()),
  );
  return windows.length ? Math.min(...windows.map((w) => w.remainingPercent)) : null;
}
export function renderQuotaNotice() {
  const box = $('quota-notice');
  box.replaceChildren();
  const current = state?.current.official && accountData?.items.find((a) => a.current);
  const remaining = current ? accountRemaining(current) : null;
  box.hidden = remaining === null || remaining > 20;
  if (box.hidden) return;
  box.append(
    document.createTextNode(
      '当前账号「' + current.label + '」有订阅额度窗口仅剩 ' + Math.round(remaining) + '%。',
    ),
  );
  const bucketId = (current.quota.buckets.find((b) => b.id === 'codex') || current.quota.buckets[0])
    .id;
  const alternative = accountData.items
    .filter((a) => !a.current && accountRemaining(a, bucketId) > 20)
    .sort((a, b) => accountRemaining(b, bucketId) - accountRemaining(a, bucketId))[0];
  if (alternative) {
    box.append(document.createTextNode('「' + alternative.label + '」同类订阅额度尚有余量。'));
    const button = rowButton(
      '选择备用账号',
      () => {
        chooseSource('account:' + alternative.id);
        $('switch').focus();
      },
      accountStatus,
    );
    button.disabled = switchPending();
    box.append(button);
  }
  box.append(document.createTextNode('不会自动切换；如有额外额度，以官方计费为准。'));
}
// compact 用于账号管理列表：一行摘要；完整进度条在选中来源的详情里。
export function quotaNode(q, compact = false) {
  const box = document.createElement('div');
  box.className = 'quota';
  const note = (text, cls = '') => {
    const line = document.createElement('small');
    line.className = cls;
    line.textContent = text;
    box.append(line);
  };
  if (!q) {
    note('额度尚未读取');
    return box;
  }
  // 当前账号的令牌即将由 Codex 续期时，后台暂不查询，避免顶掉正在使用的登录；这不是错误。
  if (q.status === 'deferred') {
    note(q.message);
    if (q.checkedAt)
      note('上次成功读取：' + new Date(q.checkedAt).toLocaleString('zh-CN'), 'quota-time');
    return box;
  }
  if (q.status === 'error') {
    // 失败时不再把旧 buckets 当成当前额度展示，避免“凭证失效但额度正常”的误解。
    note(q.error || '本次额度读取失败', 'quota-error');
    if (q.checkedAt)
      note('上次成功读取：' + new Date(q.checkedAt).toLocaleString('zh-CN'), 'quota-time');
    return box;
  }
  const duration = (n) =>
    n == null
      ? '额度窗口'
      : n % 1440 === 0
        ? n / 1440 + '天'
        : n % 60 === 0
          ? n / 60 + '小时'
          : n + '分钟';
  if (compact) {
    note(
      q.buckets
        .flatMap((b) =>
          b.windows.map(
            (w) =>
              (q.buckets.length > 1 ? b.name + ' ' : '') +
              duration(w.minutes) +
              ' ' +
              (w.remainingPercent == null ? '未返回' : Math.round(w.remainingPercent) + '%'),
          ),
        )
        .join(' · ') +
        ' · 更新于 ' +
        new Date(q.checkedAt).toLocaleString('zh-CN', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
      'quota-summary',
    );
    return box;
  }
  const time = (n) =>
    new Date(n * 1000).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  for (const b of q.buckets || []) {
    if (q.buckets.length > 1 || b.id !== 'codex') note(b.name, 'quota-bucket');
    for (const w of b.windows) {
      const line = document.createElement('div');
      line.className = 'quota-window';
      const label = document.createElement('div');
      label.className = 'quota-line';
      const title = document.createElement('span'),
        value = document.createElement('b');
      title.textContent = duration(w.minutes);
      value.textContent =
        w.remainingPercent == null
          ? '未返回比例'
          : '剩余 ' + Math.round(w.remainingPercent * 10) / 10 + '%';
      label.append(title, value);
      line.append(label);
      if (w.remainingPercent != null) {
        const bar = document.createElement('progress');
        bar.max = 100;
        bar.value = w.remainingPercent;
        bar.setAttribute('aria-label', title.textContent + '剩余额度');
        line.append(bar);
      }
      if (w.resetsAt) {
        const reset = document.createElement('small');
        reset.className = 'quota-time';
        reset.textContent = time(w.resetsAt) + ' 重置';
        line.append(reset);
      }
      box.append(line);
    }
    if (b.credits?.unlimited) note('额外额度：不限量');
    else if (b.credits?.balance != null) note('额外额度余额：' + b.credits.balance);
  }
  if (q.checkedAt)
    note(
      (q.status === 'error' ? '上次成功读取：' : '更新于 ') +
        new Date(q.checkedAt).toLocaleString('zh-CN'),
      'quota-time',
    );
  return box;
}
const day = (iso) =>
  new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
const stamp = (iso) =>
  new Date(iso).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
export function ago(iso) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return minutes < 1
    ? '刚刚'
    : minutes < 60
      ? minutes + ' 分钟前'
      : minutes < 1440
        ? Math.round(minutes / 60) + ' 小时前'
        : Math.round(minutes / 1440) + ' 天前';
}
// 会员到期时间来自登录令牌（官方最近一次核对订阅时写入）；没有这项时不显示。
export const membershipExpired = (a) =>
  !!a.subscriptionUntil && Date.parse(a.subscriptionUntil) < Date.now();
export function membership(a) {
  if (!a.subscriptionUntil) return '';
  return membershipExpired(a)
    ? '会员已于 ' + day(a.subscriptionUntil) + ' 到期'
    : '会员到期 ' + day(a.subscriptionUntil);
}
function accountFacts(a) {
  const facts = document.createElement('dl');
  facts.className = 'facts';
  const fact = (name, value, cls = '') => {
    const dt = document.createElement('dt'),
      dd = document.createElement('dd');
    dt.textContent = name;
    dd.textContent = value;
    dd.className = cls;
    facts.append(dt, dd);
  };
  fact('套餐', a.plan);
  if (a.subscriptionUntil)
    fact(
      '会员到期',
      stamp(a.subscriptionUntil) +
        (membershipExpired(a)
          ? '（已到期）'
          : '（还剩 ' +
            Math.ceil((Date.parse(a.subscriptionUntil) - Date.now()) / 86400000) +
            ' 天）'),
      membershipExpired(a) ? 'warn' : '',
    );
  fact(
    '额度读取',
    a.quota?.checkedAt
      ? stamp(a.quota.checkedAt) + '（' + ago(a.quota.checkedAt) + '）'
      : '尚未读取',
  );
  if (a.refreshedAt) fact('登录刷新', stamp(a.refreshedAt) + '（' + ago(a.refreshedAt) + '）');
  return facts;
}
export function renderSelectedQuota() {
  const a = selectedAccount(),
    box = $('official-quota');
  box.hidden = !officialTarget() || !a;
  box.replaceChildren();
  if (a) {
    box.append(accountFacts(a), quotaNode(a.quota));
    const busy = quotaRefreshing.has(a.id),
      b = rowButton(busy ? '正在读取…' : '刷新此账号额度', () => refreshQuota(a.id), accountStatus);
    b.disabled = busy;
    box.append(b);
  }
}
// 读取额度时官方可能续期令牌，套餐和会员时间随之变化；只合并这些字段，
// 不替换整份账号数据，避免覆盖其他账号正在进行的刷新结果。
const ACCOUNT_INFO = ['email', 'plan', 'subscriptionUntil', 'subscriptionCheckedAt', 'refreshedAt'];
async function syncAccountInfo(ids) {
  const fresh = await api('accounts', {});
  for (const id of ids) {
    const row = accountData.items.find((a) => a.id === id),
      next = fresh.items.find((a) => a.id === id);
    if (row && next) for (const key of ACCOUNT_INFO) row[key] = next[key];
  }
  renderAccounts();
}
export async function refreshQuota(id, sync = true) {
  // 批量刷新拆成多个账号请求，谁先返回就先更新谁，全部结束后统一同步一次账号信息；
  // 不触发全局“切换中”状态，避免覆盖用户正在编辑的模型或来源。
  if (!id) {
    const ids = (accountData?.items || []).map((a) => a.id);
    await Promise.all(ids.map((one) => refreshQuota(one, false)));
    await syncAccountInfo(ids);
    return;
  }
  if (quotaRefreshing.has(id)) return;
  quotaRefreshing.add(id);
  renderAccounts();
  try {
    const r = await api('accountQuota', { id }),
      row = accountData?.items.find((a) => a.id === id);
    if (row) row.quota = r.items.find((q) => q.id === id);
  } catch (e) {
    const row = accountData?.items.find((a) => a.id === id);
    if (row) row.quota = { ...row.quota, status: 'error', error: e.message };
  } finally {
    quotaRefreshing.delete(id);
    renderAccounts();
  }
  if (sync) await syncAccountInfo([id]);
}
export function renderAccounts() {
  if (!accountData) return;
  const data = accountData,
    switching = switchPending();
  $('account-count').textContent = data.items.length;
  $('account-summary').textContent =
    data.credentialsNotice || '保存登录供切换使用，添加不会自动启用。';
  $('account-list').replaceChildren();
  for (const a of data.items) {
    const row = document.createElement('div');
    row.className = 'prow';
    const info = document.createElement('div');
    info.className = 'account-info';
    info.append(document.createTextNode(a.label), tag(a.plan));
    if (a.current && state?.current.official)
      info.append(
        tag(a.pendingLogin ? '登录已更新 · 待应用' : '正在使用', a.pendingLogin ? 'muted' : 'done'),
      );
    const email = document.createElement('small');
    email.textContent = a.label === a.email ? 'ChatGPT 官方账号' : a.email;
    info.append(email);
    const acts = document.createElement('div');
    acts.className = 'actions';
    info.append(quotaNode(a.quota, true));
    const quotaButton = rowButton(
      quotaRefreshing.has(a.id) ? '正在读取…' : '刷新额度',
      () => refreshQuota(a.id),
      accountStatus,
    );
    acts.append(quotaButton);
    acts.append(
      rowButton(
        '重新登录',
        async () => {
          await beginLogin(a.id);
        },
        accountStatus,
      ),
    );
    acts.append(
      rowButton(
        '改名',
        async () => {
          const label = prompt('账号名称', a.label);
          if (label === null) return;
          await api('accountRename', { id: a.id, label });
          await refreshAccounts();
        },
        accountStatus,
      ),
    );
    if (!a.current)
      acts.append(
        rowButton(
          '移除',
          async () => {
            await api('accountRemove', { id: a.id });
            await refreshAccounts();
          },
          accountStatus,
        ),
      );
    for (const b of acts.children)
      b.disabled =
        switching ||
        ['starting', 'waiting'].includes(data.login?.status) ||
        quotaRefreshing.has(a.id);
    quotaButton.disabled = quotaRefreshing.has(a.id);
    row.append(info, acts);
    $('account-list').append(row);
  }
  const login = data.login,
    waiting = login?.status === 'waiting';
  $('login-panel').hidden = !waiting;
  $('account-add').disabled = waiting || switching || pendingRequests.has($('account-add'));
  $('quota-refresh').disabled =
    !data.items.length || data.items.every((a) => quotaRefreshing.has(a.id));
  $('quota-refresh').textContent = quotaRefreshing.size
    ? '正在刷新 ' + quotaRefreshing.size + ' 个账号…'
    : '刷新全部额度';
  renderSelectedQuota();
  // 额度变化要同步到来源卡片和状态卡；state 可能晚于账号返回。
  if (state) {
    renderSources();
    renderSummary();
  }
  if (waiting) {
    $('login-message').textContent = login.message;
    $('login-link').href = login.authUrl;
  }
}
export let lastJobMessage = '';
export let reloadWatchUntil = 0;
export async function refreshAccounts() {
  const wasSwitching = switchPending();
  const data = setAccountData(await api('accounts', {})),
    login = data.login,
    switching = switchPending();
  renderAccounts();
  renderSwitchProgress();
  if (login?.status === 'waiting') accountStatus('等待官方页面完成登录…');
  else if (login && ['done', 'error', 'cancelled'].includes(login.status))
    accountStatus(login.message);
  const job = data.switchJob;
  if (job) {
    const key = JSON.stringify(job);
    if (key !== lastJobMessage && (switching || accountTimer))
      status(
        job.message +
          (job.status === 'error' ? '\n如需排查，可在“编辑器与诊断”导出诊断日志发给维护者。' : ''),
      );
    lastJobMessage = key;
  }
  if (state) {
    renderSelect(true);
    renderSummary();
  }
  const windows = job?.editorReload?.results || [];
  const waitingReload = windows.some((w) => ['pending', 'received'].includes(w.status));
  if (wasSwitching && !switching) reloadWatchUntil = Date.now() + 30000;
  if (waitingReload && job?.finishedAt)
    reloadWatchUntil = Math.max(reloadWatchUntil, Date.parse(job.finishedAt) + 30000);
  const active =
    login?.status === 'waiting' || switching || (waitingReload && Date.now() < reloadWatchUntil);
  if (wasSwitching && !switching) await refresh();
  if (!active && accountTimer) {
    clearInterval(accountTimer);
    accountTimer = null;
  }
  if (login?.status === 'done' && login.accountId !== lastQuotaLogin) {
    lastQuotaLogin = login.accountId;
    queueMicrotask(() => refreshQuota(login.accountId).catch((e) => accountStatus(e.message)));
  }
  if (active) watchAccounts();
  return data;
}
export function watchAccounts() {
  if (!accountTimer)
    accountTimer = setInterval(
      () =>
        refreshAccounts().catch((e) => {
          status(e.message);
          clearInterval(accountTimer);
          accountTimer = null;
        }),
      1500,
    );
}
export async function beginLogin(id) {
  accountStatus(id ? '正在准备重新登录…' : '正在打开官方登录…');
  const login = await api('accountLogin', id ? { id } : {});
  showTab('accounts');
  $('login-panel').hidden = false;
  $('login-message').textContent = login.message;
  $('login-link').href = login.authUrl;
  watchAccounts();
  await refreshAccounts();
}
$('account-add').onclick = () => busy($('account-add'), () => beginLogin(), accountStatus);
$('quota-refresh').onclick = () => refreshQuota().catch((e) => accountStatus(e.message));
$('login-cancel').onclick = () =>
  busy(
    $('login-cancel'),
    async () => {
      await api('accountLoginCancel', {});
      await refreshAccounts();
    },
    accountStatus,
  );
