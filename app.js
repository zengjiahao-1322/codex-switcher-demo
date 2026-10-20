'use strict';
const $ = (id) => document.getElementById(id);
// 网页与桌面快捷方式统一使用主页建立的本机会话，直接访问无需附带令牌。
if (location.hash) {
  history.replaceState(null, '', location.pathname + location.search);
}
let state = null,
  editing = null,
  accountData = null;
const pendingRequests = new Set(),
  modelCache = new Map();
async function api(route, data) {
  let r;
  try {
    const options = {
      method: data ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: {
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    };
    r = await fetch('/api/' + route, options);
    if (r.status === 401) {
      // 后台重启会更新凭证；旧标签页自动重新建立会话，再重试一次原请求。
      const session = await fetch('/', { credentials: 'same-origin', cache: 'no-store' });
      await session.text();
      if (session.ok) r = await fetch('/api/' + route, options);
    }
  } catch {
    throw Error('本机服务未连接，请重新打开桌面上的切换器快捷方式。');
  }
  const j = await r.json();
  if (!r.ok) throw Error(j.error || '请求失败');
  return j;
}
const status = (s) => {
  $('status').textContent = s;
};
const providerStatus = (s) => {
  $('provider-status').hidden = !s;
  $('provider-status').textContent = s || '';
};
async function busy(button, fn, report = status) {
  pendingRequests.add(button);
  button.disabled = true;
  if (state) updateSwitchAction();
  try {
    await fn();
  } catch (e) {
    report('失败：' + e.message);
  } finally {
    pendingRequests.delete(button);
    button.disabled =
      button.id === 'account-add' && (accountData?.login?.status === 'waiting' || switchPending());
    if (state) updateSwitchAction();
  }
}
function tag(text, cls) {
  const t = document.createElement('span');
  t.className = 'tag' + (cls ? ' ' + cls : '');
  t.textContent = text;
  return t;
}
const modeLabels = {
  responses: 'Responses',
  chat_completions: 'Chat Completions',
  anthropic_messages: 'Anthropic',
};
// 接入方式（最近一次检测）：直连 = Codex 直接访问；经本机转换 = 经本工具 127.0.0.1 转换服务。
const accessLabels = {
  official: ['官方登录', 'official'],
  direct: ['直连', 'done'],
  adapter: ['经本机转换', 'custom'],
  failed: ['未通过', 'changed'],
  unknown: ['未检测', 'muted'],
};
const accessOf = (p) => accessLabels[p.access?.mode] || accessLabels.unknown;
const accessTag = (p) => {
  const [t, c] = accessOf(p);
  const el = tag(t, c);
  if (p.access?.at)
    el.title = `${new Date(p.access.at).toLocaleString('zh-CN')} 检测（模型 ${p.access.model}）：${p.access.message || ''}`;
  return el;
};

// 模型下拉框：点开/聚焦显示全部（当前项高亮）；输入时按 开头匹配 > 分段开头匹配 > 包含匹配 排序并高亮；无匹配时提示将使用输入的名称。
function combo(input, getOptions) {
  const list = document.createElement('div');
  list.className = 'combo-list';
  list.hidden = true;
  list.setAttribute('role', 'listbox');
  input.parentElement.append(list);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  let items = [],
    active = -1,
    showAll = false,
    picking = false;
  const LIMIT = 300;
  const rank = (m, q) => {
    const s = m.toLowerCase();
    if (s === q) return 0;
    if (s.startsWith(q)) return 1;
    if (s.split(/[-_/.:~@ ]+/).some((part) => part.startsWith(q))) return 2;
    return s.includes(q) ? 3 : -1;
  };
  const note = (text) => {
    const n = document.createElement('div');
    n.className = 'combo-note';
    n.textContent = text;
    list.append(n);
  };
  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  }
  function highlight(el, m, q) {
    const i = q ? m.toLowerCase().indexOf(q) : -1;
    if (i < 0) {
      el.textContent = m;
      return;
    }
    const b = document.createElement('b');
    b.textContent = m.slice(i, i + q.length);
    el.append(m.slice(0, i), b, m.slice(i + q.length));
  }
  function render() {
    const all = getOptions(),
      value = input.value.trim(),
      q = showAll ? '' : value.toLowerCase();
    items = q
      ? all
          .map((m) => [m, rank(m, q)])
          .filter((x) => x[1] >= 0)
          .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
          .map((x) => x[0])
      : [...all];
    list.replaceChildren();
    if (!all.length) note('还没有模型列表：点右侧按钮获取，或直接输入模型名称。');
    else if (!items.length) note(`没有匹配“${value}”的模型，将直接使用你输入的名称。`);
    else {
      if (q) note(`匹配 ${items.length} / ${all.length} 个模型`);
      items.slice(0, LIMIT).forEach((m, i) => {
        const el = document.createElement('div');
        el.className =
          'combo-item' + (m === value ? ' current' : '') + (i === active ? ' active' : '');
        el.setAttribute('role', 'option');
        highlight(el, m, q);
        el.onmousedown = (e) => {
          e.preventDefault();
          pick(m);
        };
        list.append(el);
      });
      if (items.length > LIMIT) note(`仅显示前 ${LIMIT} 个，请输入关键字缩小范围。`);
    }
    list.style.pointerEvents = items.length ? '' : 'none';
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    const cur = list.querySelector('.active') || (showAll ? list.querySelector('.current') : null);
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  function pick(m) {
    picking = true;
    input.value = m;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    picking = false;
    close();
  }
  input.addEventListener('focus', () => {
    showAll = true;
    active = -1;
    render();
  });
  input.addEventListener('click', () => {
    if (list.hidden) {
      showAll = true;
      render();
    }
  });
  input.addEventListener('input', () => {
    if (picking) return;
    showAll = false;
    active = -1;
    render();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) {
        showAll = true;
        render();
      }
      const n = Math.min(items.length, LIMIT);
      if (!n) return;
      active = e.key === 'ArrowDown' ? (active + 1) % n : active <= 0 ? n - 1 : active - 1;
      render();
      return;
    }
    if (e.key === 'Enter' && !list.hidden && active >= 0 && items[active]) {
      e.preventDefault();
      pick(items[active]);
    }
  });
  return { close };
}
const merge = (a, b) => [...new Set([...a, ...b])].sort((x, y) => x.localeCompare(y));
let topModels = [],
  formModels = [];

// 保存的账号只在管理区维护，所有使用操作统一到来源选择器。
const accountStatus = (text) => {
  $('account-status').textContent = text || '';
};
let accountTimer = null,
  lastQuotaLogin = null;
const quotaRefreshing = new Set();
// 只使用近期成功读取、尚未重置的窗口；旧缓存和读取失败不推断为额度耗尽。
function accountRemaining(account, bucketId) {
  const quota = account.quota;
  if (
    account.pendingLogin ||
    quota?.status !== 'ok' ||
    Date.now() - Date.parse(quota.checkedAt) > 600000 ||
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
function renderQuotaNotice() {
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
        $('provider').value = 'account:' + alternative.id;
        selected();
        $('switch').focus();
      },
      accountStatus,
    );
    button.disabled = switchPending();
    box.append(button);
  }
  box.append(document.createTextNode('不会自动切换；如有额外额度，以官方计费为准。'));
}
function quotaNode(q) {
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
  if (q.status === 'error') note(q.error, 'quota-error');
  const duration = (n) =>
    n == null
      ? '额度窗口'
      : n % 1440 === 0
        ? n / 1440 + '天'
        : n % 60 === 0
          ? n / 60 + '小时'
          : n + '分钟';
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
function renderSelectedQuota() {
  const a = selectedAccount(),
    box = $('official-quota');
  box.hidden = !officialTarget() || !a;
  box.replaceChildren();
  if (a) {
    box.append(quotaNode(a.quota));
    const busy = quotaRefreshing.has(a.id),
      b = rowButton(busy ? '正在读取…' : '刷新此账号额度', () => refreshQuota(a.id), accountStatus);
    b.disabled = busy;
    box.append(b);
  }
}
async function refreshQuota(id) {
  // 批量刷新拆成多个账号请求，谁先返回就先更新谁；不重绘来源选择器，
  // 也不触发全局“切换中”状态，避免覆盖用户正在编辑的模型或来源。
  if (!id) {
    await Promise.all((accountData?.items || []).map((a) => refreshQuota(a.id)));
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
}
const officialTarget = () =>
  ['official'].includes($('provider').value) || $('provider').value.startsWith('account:');
const selectedAccount = () =>
  accountData?.items.find((a) => 'account:' + a.id === $('provider').value);
const selectedProvider = () =>
  state?.providers.find((p) => p.id === (officialTarget() ? 'official' : $('provider').value));
const switchPending = () =>
  ['queued', 'preparing', 'switching', 'reopening'].includes(accountData?.switchJob?.status);
function updateSwitchAction() {
  const p = selectedProvider(),
    a = selectedAccount(),
    official = officialTarget(),
    same = official
      ? state?.current.official && a?.current && !a?.pendingLogin
      : p?.inUse && $('model').value.trim() === state?.current.model;
  const locked = pendingRequests.has($('switch')) || switchPending();
  $('provider').disabled = locked;
  $('model').disabled = locked;
  $('fetch-models').disabled = locked || official || pendingRequests.has($('fetch-models'));
  $('probe').disabled = locked || official || pendingRequests.has($('probe'));
  $('probe').hidden = official;
  $('switch').disabled = locked || !p || (!official && !$('model').value.trim());
  $('switch').textContent = locked
    ? '正在切换…'
    : official
      ? a
        ? same
          ? '重新应用'
          : '应用此账号'
        : '添加官方账号'
      : same
        ? '重新应用'
        : '应用此 API';
}
function renderAccounts() {
  if (!accountData) return;
  const data = accountData,
    switching = switchPending();
  $('account-count').textContent = ' · ' + data.items.length;
  $('account-summary').textContent =
    data.credentialsNotice || '保存登录供切换使用，添加不会自动启用。';
  $('account-list').replaceChildren();
  for (const a of data.items) {
    const row = document.createElement('div');
    row.className = 'prow';
    const info = document.createElement('div');
    info.className = 'account-info';
    info.append(document.createTextNode(a.label), tag(a.plan));
    if (a.current)
      info.append(
        tag(
          a.pendingLogin
            ? '登录已更新 · 待应用'
            : state?.current.official
              ? '当前配置'
              : '已保留登录',
          state?.current.official ? 'done' : 'muted',
        ),
      );
    const email = document.createElement('small');
    email.textContent = a.label === a.email ? 'ChatGPT 官方账号' : a.email;
    info.append(email);
    const acts = document.createElement('div');
    acts.className = 'actions';
    info.append(quotaNode(a.quota));
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
  renderQuotaNotice();
  if (waiting) {
    $('login-message').textContent = login.message;
    $('login-link').href = login.authUrl;
  }
}
let lastJobMessage = '';
let reloadWatchUntil = 0;
let progressJob = null;
function renderSwitchProgress() {
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
  if (job.configurationApplied) {
    const line = document.createElement('p');
    line.textContent =
      '配置已保存' +
      (job.threadRouting ? ' · 已核对 ' + job.threadRouting.count + ' 条旧对话' : '');
    $('switch-windows').append(line);
  }
  if (job.desktopRequested) {
    const line = document.createElement('p');
    line.textContent = '桌面端：已请求重新打开，尚未确认实际请求来源。';
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
async function refreshAccounts() {
  const wasSwitching = switchPending();
  const data = (accountData = await api('accounts', {})),
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
    if (key !== lastJobMessage && (switching || accountTimer)) status(job.message);
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
function watchAccounts() {
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

function selected(resetModel = true) {
  const p = selectedProvider(),
    official = officialTarget();
  if (resetModel) {
    $('model').value = (p?.inUse && state.current.model) || p?.model || '';
    topCombo.close();
  }
  topModels = merge(p?.models || [], modelCache.get(p?.id) || []);
  $('model-fields').hidden = official;
  $('connection-details').hidden = official;
  $('source-context').textContent =
    (official ? '使用官方服务与所选账号。' : '先检测 API 并准备模型列表。') +
    '应用后重启桌面端、重载已连接的插件窗口；只安装插件也可使用。运行中的任务会中断。';
  $('endpoint').textContent =
    p && !official ? p.baseUrl + ' · 协议 ' + (modeLabels[p.apiMode] || p.apiMode) : '';
  const last = p?.access || {};
  const hints = {
    direct: '可直连：Codex 直接访问供应商，无需转换服务。',
    adapter: '经本机转换：转换服务需保持运行，不支持 Codex 内置网页搜索。',
    failed: '上次检测未通过：' + String(last.message || '').replace(/^未通过：/, ''),
    unknown: '首次应用会自动检测接入方式。',
  };
  $('mode-hint').hidden = !p || official;
  $('mode-hint').className = 'hint' + (last.mode === 'failed' ? ' warn' : '');
  $('mode-hint').textContent = p
    ? (hints[last.mode] || hints.unknown) +
      (p.local ? ' 这是你电脑上的另一个代理服务。' : '') +
      (!official && !p.hasKey && !p.local ? ' 请先在 API 配置中填写密钥。' : '')
    : '';
  updateSwitchAction();
  renderSelectedQuota();
}
function renderSummary() {
  const c = state.current;
  $('summary').replaceChildren(document.createTextNode('当前配置：'));
  const b = document.createElement('b');
  const account = accountData?.items.find((a) => a.current);
  b.textContent = c.official
    ? '官方 · ' + (account?.label || '未登录')
    : 'API · ' + c.name + ' · ' + (c.model || '默认模型');
  $('summary').append(b);
  $('summary').title = state.codexVersion || '';
  renderQuotaNotice();
}
function renderService() {
  const a = state.adapter;
  $('autostart').checked = !!a.autostart;
  $('service').textContent = a.ready
    ? '转换服务运行中 · 端口 ' + a.port
    : '转换服务未运行或端口 ' + a.port + ' 被占用。';
}
function renderSelect(keepDraft = false) {
  const keep = $('provider').value;
  $('provider').replaceChildren();
  const group = (name) => {
    const g = document.createElement('optgroup');
    g.label = name;
    $('provider').append(g);
    return g;
  };
  const add = (g, value, name, inUse) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = name + (inUse ? '（已配置）' : '');
    g.append(o);
  };
  const official = group('官方账号'),
    items = accountData?.items || [];
  if (items.length)
    for (const a of items)
      add(official, 'account:' + a.id, a.label, state.current.official && a.current);
  else add(official, 'official', 'ChatGPT 官方登录', state.current.official);
  const apis = state.providers.filter((p) => p.id !== 'official');
  if (apis.length) {
    const g = group('自定义 API');
    for (const p of apis) add(g, p.id, p.name, p.inUse);
  }
  const current = state.current.official
    ? items.find((a) => a.current)
      ? 'account:' + items.find((a) => a.current).id
      : 'official'
    : apis.find((p) => p.inUse)?.id;
  const options = [...$('provider').options],
    valid = options.some((o) => o.value === keep),
    next = valid ? keep : current;
  $('provider').value = options.some((o) => o.value === next) ? next : options[0]?.value;
  selected(!(keepDraft && valid));
}
function updateAccess(id, access) {
  const p = state.providers.find((x) => x.id === id);
  if (!p) return;
  p.access = access;
  renderProviderList();
  if (id === $('provider').value) {
    const v = $('model').value;
    selected();
    $('model').value = v;
    updateSwitchAction();
  }
}

// ---- 配置列表与表单 ----
function rowButton(text, fn, report = providerStatus) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.onclick = () => busy(b, fn, report);
  return b;
}
function renderProviderList() {
  const providers = state.providers.filter((p) => p.id !== 'official');
  $('provider-list').replaceChildren();
  $('list-count').textContent = '共 ' + providers.length + ' 个配置';
  $('api-count').textContent = ' · ' + providers.length;
  for (const p of providers) {
    const row = document.createElement('div');
    row.className = 'prow' + (editing === p.id ? ' editing' : '');
    const info = document.createElement('div');
    info.append(document.createTextNode(p.name), accessTag(p));
    if (p.id !== 'official') {
      info.append(tag('协议 ' + (modeLabels[p.apiMode] || p.apiMode)));
      if (p.local) info.append(tag('本机代理'));
      if (!p.hasKey && !p.local) info.append(tag('缺少密钥', 'changed'));
    }
    if (p.inUse) info.append(tag('已配置', 'done'));
    const d = document.createElement('small');
    d.textContent =
      p.id === 'official'
        ? `${p.baseUrl} · 模型 ${p.model || '（Codex 默认）'}`
        : `${p.baseUrl} · 默认模型 ${p.model}`;
    info.append(d);
    row.append(info);
    if (p.id !== 'official') {
      const acts = document.createElement('div');
      acts.className = 'actions';
      acts.append(
        rowButton('编辑', async () => startEdit(p)),
        rowButton('删除', async () => {
          if (!confirm(`删除配置“${p.name}”？此操作不能撤销（密钥一并删除）。`)) return;
          const r = await api('providerRemove', { id: p.id });
          providerStatus(r.message);
          if (editing === p.id) resetForm();
          await refresh();
        }),
      );
      row.append(acts);
    }
    $('provider-list').append(row);
  }
  $('import-hermes').hidden = !state.hermesAvailable;
}
let pickerModels = [],
  formRevision = 0;
const formContext = () =>
  JSON.stringify([formRevision, editing, $('pf-url').value, $('pf-mode').value, $('pf-key').value]);
const extraModels = () =>
  $('pf-models')
    .value.split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
function renderPicker() {
  const q = $('pf-filter').value.trim().toLowerCase(),
    extra = new Set(extraModels()),
    def = $('pf-model').value.trim();
  const shown = pickerModels.filter((m) => !q || m.toLowerCase().includes(q));
  $('pf-picker-list').replaceChildren();
  for (const m of shown.slice(0, 300)) {
    const row = document.createElement('div');
    row.className = 'mrow' + (m === def ? ' default' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = extra.has(m);
    cb.title = '加入其他可选模型';
    cb.onchange = () => {
      const list = extraModels().filter((x) => x !== m);
      if (cb.checked) list.push(m);
      $('pf-models').value = list.join(', ');
    };
    const name = document.createElement('span');
    name.textContent = m;
    const set = document.createElement('button');
    set.type = 'button';
    set.textContent = m === def ? '默认' : '设为默认';
    set.disabled = m === def;
    set.onclick = () => {
      $('pf-model').value = m;
      renderPicker();
    };
    row.append(cb, name, set);
    $('pf-picker-list').append(row);
  }
  $('pf-picker-note').textContent =
    `共 ${pickerModels.length} 个模型` +
    (q ? `，筛选出 ${shown.length} 个` : '') +
    (shown.length > 300 ? '（仅显示前 300 个，请输入关键字筛选）' : '');
}
function resetPicker() {
  formRevision++;
  pickerModels = [];
  formModels = [];
  $('pf-picker').hidden = true;
  $('pf-filter').value = '';
}
function resetForm() {
  providerStatus('');
  resetPicker();
  editing = null;
  $('provider-form').reset();
  $('form-title').textContent = '新增配置';
  $('pf-key').placeholder = '';
  $('pf-cancel').hidden = true;
  $('pf-save').textContent = '保存配置';
  if (state) renderProviderList();
}
function startEdit(p) {
  providerStatus('');
  $('api-manager').open = true;
  resetPicker();
  formModels = merge([], p.models || []);
  editing = p.id;
  $('form-title').textContent = '编辑配置：' + p.name;
  $('pf-name').value = p.name;
  $('pf-url').value = p.baseUrl;
  $('pf-mode').value = p.apiMode;
  $('pf-model').value = p.model;
  $('pf-models').value = (p.models || []).filter((m) => m !== p.model).join(', ');
  $('pf-key').value = '';
  $('pf-key').placeholder = p.hasKey ? '留空则保留原密钥' : '尚未填写密钥';
  $('pf-cancel').hidden = false;
  $('pf-save').textContent = '保存修改';
  renderProviderList();
  $('form-title').scrollIntoView({ block: 'start', behavior: 'smooth' });
  $('pf-name').focus({ preventScroll: true });
}

function renderEffect() {
  $('effect-notice').hidden = !state?.effect?.message;
  $('effect-notice').textContent = state?.effect?.message || '';
}
function renderDiagnosis() {
  if ($('diagnosis-details').open) runDiagnosis();
}
async function refresh() {
  state = await api('state');
  renderEffect();
  renderDiagnosis();
  renderSummary();
  renderService();
  renderProviderList();
  renderSelect(true);
  renderAccounts();
  $('usage-notice').hidden = !state.usage?.notice;
  $('usage-notice').textContent = state.usage?.notice || '';
  if (state.notice) providerStatus(state.notice);
}

// ---- 事件 ----
const topCombo = combo($('model'), () => topModels);
combo($('pf-model'), () => formModels);
async function beginLogin(id) {
  accountStatus(id ? '正在准备重新登录…' : '正在打开官方登录…');
  const login = await api('accountLogin', id ? { id } : {});
  $('account-manager').open = true;
  $('login-panel').hidden = false;
  $('login-message').textContent = login.message;
  $('login-link').href = login.authUrl;
  watchAccounts();
  await refreshAccounts();
}
$('account-add').onclick = () => busy($('account-add'), () => beginLogin(), accountStatus);
$('quota-refresh').onclick = () => refreshQuota().catch((e) => accountStatus(e.message));
$('account-manager').ontoggle = () => {
  if (
    $('account-manager').open &&
    accountData?.items.some(
      (a) => !a.quota || Date.now() - Date.parse(a.quota.checkedAt || 0) > 60000,
    )
  )
    refreshQuota().catch((e) => accountStatus(e.message));
};
$('login-cancel').onclick = () =>
  busy(
    $('login-cancel'),
    async () => {
      await api('accountLoginCancel', {});
      await refreshAccounts();
    },
    accountStatus,
  );
$('provider').onchange = () => {
  status('');
  selected();
};
$('model').addEventListener('input', updateSwitchAction);
$('fetch-models').onclick = () =>
  busy($('fetch-models'), async () => {
    const id = $('provider').value;
    status('正在获取模型列表…');
    const r = await api('models', { id });
    modelCache.set(id, r.models);
    if ($('provider').value !== id) return;
    topModels = merge(selectedProvider()?.models || [], r.models);
    status(r.message + '点“模型”输入框即可选择，也可输入关键字筛选。');
    $('model').focus();
  });
function detectApi() {
  return busy($('probe'), async () => {
    const id = $('provider').value,
      model = $('model').value.trim();
    status('检测 API 中…');
    const r = await api('probe', { id, model });
    updateAccess(id, {
      mode: r.ok ? r.mode : 'failed',
      model,
      at: new Date().toISOString(),
      message: r.message,
    });
    status(r.message);
  });
}
$('probe').onclick = detectApi;
$('switch').onclick = () =>
  busy($('switch'), async () => {
    if (officialTarget()) {
      const a = selectedAccount();
      if (!a) {
        $('account-manager').open = true;
        $('account-add').click();
        return;
      }
      status('正在准备应用账号…');
      const r = await api('accountSwitch', {
        id: a.id,
        reloadEditors: $('reload-editors').checked,
      });
      status(r.message);
      accountData.switchJob = { status: 'queued' };
      watchAccounts();
      await refreshAccounts();
    } else {
      const id = $('provider').value,
        model = $('model').value.trim();
      status('正在准备应用 API…');
      const r = await api('desktopSwitch', {
        id,
        model,
        reloadEditors: $('reload-editors').checked,
      });
      status(r.message);
      accountData.switchJob = { status: 'queued' };
      watchAccounts();
      await refreshAccounts();
    }
  });
$('autostart').onchange = () =>
  busy($('autostart'), async () => {
    const r = await api('autostart', { enabled: $('autostart').checked });
    status(r.message);
    await refresh();
  });
$('import-hermes').onclick = () =>
  busy(
    $('import-hermes'),
    async () => {
      const r = await api('importHermes', {});
      providerStatus(r.message);
      await refresh();
    },
    providerStatus,
  );
$('pf-cancel').onclick = resetForm;
$('pf-fetch').onclick = () =>
  busy(
    $('pf-fetch'),
    async () => {
      const context = formContext();
      providerStatus('正在获取模型列表…');
      const r = await api('models', {
        id: editing || undefined,
        baseUrl: $('pf-url').value,
        apiMode: $('pf-mode').value,
        apiKey: $('pf-key').value,
      });
      if (context !== formContext()) return;
      pickerModels = r.models;
      formModels = merge(formModels, r.models);
      $('pf-picker').hidden = false;
      renderPicker();
      providerStatus(r.message + '可点“设为默认”，或勾选加入其他可选模型。');
    },
    providerStatus,
  );
$('pf-filter').oninput = renderPicker;
$('pf-models').oninput = () => {
  if (pickerModels.length) renderPicker();
};
$('pf-model').addEventListener('input', () => {
  if (pickerModels.length) renderPicker();
});
$('provider-form').onsubmit = (e) => {
  e.preventDefault();
  busy(
    $('pf-save'),
    async () => {
      const data = {
        name: $('pf-name').value,
        baseUrl: $('pf-url').value,
        apiMode: $('pf-mode').value,
        model: $('pf-model').value,
        models: $('pf-models').value,
        apiKey: $('pf-key').value,
      };
      if (!editing && !data.apiKey) throw Error('请填写 API 密钥');
      const r = editing
        ? await api('providerUpdate', { id: editing, ...data })
        : await api('providerAdd', data);
      $('pf-key').value = '';
      const newId = r.id;
      modelCache.delete(editing);
      resetForm();
      await refresh();
      providerStatus(r.message);
      if (newId) {
        $('provider').value = newId;
        selected();
      }
    },
    providerStatus,
  );
};
let lastClients = '';
async function refreshClients() {
  if (!lastClients) $('clients-status').textContent = '正在查看运行中的 Codex…';
  try {
    const c = await api('clients', {});
    $('clients-status').textContent =
      `本次切换目录：${c.home}\nCodex 程序：${c.runtime || '未找到，请安装官方扩展或填写下方路径'}\n检测到 ${c.clients.length} 个客户端 / 窗口，${c.connectedEditors} 个伴随扩展连接。`;
    if (document.activeElement !== $('config-home')) $('config-home').value = c.home;
    $('config-homes').replaceChildren();
    for (const home of new Set(c.clients.map((p) => p.home).filter(Boolean))) {
      const option = document.createElement('option');
      option.value = home;
      $('config-homes').append(option);
    }
    const key = JSON.stringify([c.clients, c.auxiliary, c.editors]);
    if (key === lastClients) return;
    lastClients = key;
    $('clients-list').replaceChildren();
    for (const client of c.clients) {
      const row = document.createElement('div');
      row.className = 'client-row';
      const title = document.createElement('b');
      title.textContent = client.name + ' · PID ' + client.pid;
      row.append(
        title,
        tag(
          client.remote || client.wsl
            ? '远程 / WSL 独立环境'
            : client.confirmed
              ? client.shared
                ? '共用当前目录'
                : '独立目录'
              : '归属未确认',
          client.shared ? 'done' : 'muted',
        ),
      );
      const detail = document.createElement('small');
      detail.textContent =
        (client.home || '尚未确认 CODEX_HOME') +
        (client.homeSource
          ? ' · ' + (client.homeSource === 'default' ? '进程默认目录' : '进程 CODEX_HOME')
          : '') +
        (client.error ? '\n进程读取失败：' + client.error : '') +
        (client.workspace ? '\n' + client.workspace : '') +
        (client.kind === 'editor' && !client.confirmed
          ? '\n尚未确认此窗口的 Codex 后端。请打开 Codex 扩展；若已打开，请查看其输出是否启动失败。'
          : '') +
        (client.kind === 'editor'
          ? '\n伴随扩展：' + (client.companionVersion || '版本未知，可重新接入以更新')
          : '') +
        (client.commandPending ? '\n重载请求等待窗口接收；请查看编辑器状态栏是否已连接。' : '') +
        (client.lastAck?.status === 'reload_requested'
          ? '\n窗口已接收重载请求；若仍显示旧进程，请检查编辑器是否有待处理的保存或任务提示。'
          : '') +
        (client.lastAck?.status === 'reloaded'
          ? '\n伴随扩展已重载并重新连接；尚未验证实际模型请求。'
          : '') +
        (client.lastAck?.status === 'reload_failed' ? '\n重载失败：' + client.lastAck.error : '') +
        (client.stale ? '\n启动早于最近切换，可能需重载。' : '') +
        (client.overridden ? '\n配置档 / 启动参数覆盖了全局模型或供应商，请展开核对。' : '');
      row.append(detail);
      if (client.layers?.length > 1) {
        const layers = document.createElement('details'),
          summary = document.createElement('summary');
        summary.textContent = '配置层与启动覆盖';
        layers.append(summary);
        for (const l of client.layers) {
          const line = document.createElement('small');
          line.textContent =
            l.source + '：' + (l.file || '') + ' ' + (l.error || JSON.stringify(l.values));
          layers.append(line);
        }
        row.append(layers);
      }
      if (client.canReload)
        row.append(
          rowButton(
            client.commandPending ? '重载请求已发送' : '重载此窗口',
            async () => {
              const r = await api('reloadClients', { id: client.editorId });
              status(r.message);
              await refreshClients();
            },
            status,
          ),
        );
      else if (client.kind === 'ide' && !client.editorId) {
        const note = document.createElement('small');
        note.textContent = '安装下方伴随扩展后可精确重载此窗口。';
        row.append(note);
      }
      $('clients-list').append(row);
    }
    if (c.auxiliary?.length) {
      const extra = document.createElement('details'),
        summary = document.createElement('summary');
      summary.textContent = `辅助后台 ${c.auxiliary.length} 个（不计入客户端数量）`;
      extra.append(summary);
      for (const p of c.auxiliary) {
        const line = document.createElement('p');
        line.className = 'note';
        line.textContent = `${p.name} · PID ${p.pid}\n${p.home || '配置目录未确认'}${p.shared ? ' · 共用当前目录' : ''}。由自动化工具启动，不代表另一个桌面窗口。`;
        extra.append(line);
      }
      $('clients-list').append(extra);
    }
    $('companion-install').replaceChildren();
    for (const editor of c.editors || [])
      $('companion-install').append(
        rowButton(
          '接入 ' + editor.name,
          async () => {
            status('正在安装伴随扩展…');
            const r = await api('companionInstall', { id: editor.id });
            status(r.message);
            await refreshClients();
          },
          status,
        ),
      );
  } catch (e) {
    $('clients-status').textContent = e.message;
  }
}
let clientsTimer = null;
$('client-details').ontoggle = () => {
  if (clientsTimer) {
    clearInterval(clientsTimer);
    clientsTimer = null;
  }
  if ($('client-details').open) {
    refreshClients();
    clientsTimer = setInterval(refreshClients, 5000);
  }
};
$('clients-refresh').onclick = refreshClients;
$('environment-save').onclick = () =>
  busy($('environment-save'), async () => {
    const r = await api('setEnvironment', {
      home: $('config-home').value,
      codexExe: $('runtime-path').value,
    });
    lastClients = null;
    modelCache.clear();
    await refreshAccounts();
    await refresh();
    await refreshClients();
    status(r.message);
  });
$('companion-download').onclick = () =>
  busy($('companion-download'), async () => {
    const r = await api('companionPackage', {}),
      a = document.createElement('a');
    a.href = r.url;
    a.download = r.filename;
    a.textContent = '下载 ' + r.filename;
    a.style.color = 'var(--accent)';
    $('companion-install').replaceChildren(a);
    status('安装包已生成，点击旁边的下载链接。下载后在 VS Code 扩展菜单选择“从 VSIX 安装”。');
  });
let diagnosisSeq = 0,
  threadsSeq = 0;
async function refreshThreads() {
  const seq = ++threadsSeq,
    r = await api('threads', { query: $('thread-query').value });
  if (seq !== threadsSeq) return;
  const keep = $('diagnosis-thread').value;
  $('diagnosis-thread').replaceChildren(new Option('当前配置', ''));
  for (const t of r.items) {
    const title = (t.title || t.id).replace(/\s+/g, ' ');
    $('diagnosis-thread').append(
      new Option(
        (t.archived ? '[已归档] ' : '') +
          title.slice(0, 100) +
          (title.length > 100 ? '…' : '') +
          ' · ' +
          t.model_provider,
        t.id,
      ),
    );
  }
  if ([...$('diagnosis-thread').options].some((o) => o.value === keep))
    $('diagnosis-thread').value = keep;
  if (r.error) $('diagnosis-status').textContent = r.error;
}
function chooseSource(value, model) {
  $('provider').value = value;
  selected();
  if (model && !officialTarget()) {
    $('model').value = model;
    updateSwitchAction();
  }
  $('provider').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function diagnosisAction(action) {
  if (action.type === 'accounts') {
    $('account-manager').open = true;
    $('account-manager').scrollIntoView({ behavior: 'smooth' });
    return;
  }
  if (action.type === 'reauth') return beginLogin(action.id);
  if (['official', 'account'].includes(action.type)) {
    const a =
      accountData.items.find((a) => a.id === action.id) ||
      accountData.items.find((a) => a.current) ||
      accountData.items[0];
    chooseSource(a ? 'account:' + a.id : 'official');
    status('已选中官方账号，请点“切换并重启”。');
    return;
  }
  if (action.type === 'api') {
    const p =
      state.providers.find((p) => p.id !== 'official' && p.inUse) ||
      state.providers.find((p) => p.id !== 'official');
    if (p) chooseSource(p.id, action.model);
    status('请选择原 API；历史的共享供应商标记无法证明是哪家 API。');
    return;
  }
  if (action.type === 'reapply') {
    const a = accountData.items.find((a) => a.current),
      p = state.providers.find((p) => p.inUse);
    chooseSource(state.current.official ? (a ? 'account:' + a.id : 'official') : p.id);
    $('switch').click();
    return;
  }
  if (action.type === 'probe') {
    const p = state.providers.find((p) => p.id !== 'official' && p.inUse);
    if (!p) throw Error('当前未找到正在使用的 API 配置');
    const r = await api('probe', { id: p.id, model: state.current.model });
    const line = document.createElement('p');
    line.textContent = '实时检测：' + r.message;
    $('diagnosis-status').append(line);
    return;
  }
  if (action.type === 'export') {
    const r = await api('exportContext', { id: action.id }),
      line = document.createElement('p');
    line.textContent = r.message + '\n' + r.file;
    $('diagnosis-status').append(line);
    $('diagnosis-actions').append(
      rowButton(
        '复制新会话提示',
        async () => {
          await navigator.clipboard.writeText(
            '请读取此历史对话上下文文件，先概括已有进展，再继续我的任务：' + r.file,
          );
          status('已复制。新建 Codex 会话后粘贴即可。');
        },
        status,
      ),
    );
    return;
  }
}
async function runDiagnosis() {
  const seq = ++diagnosisSeq,
    id = $('diagnosis-thread').value;
  $('diagnosis-status').textContent = '正在检查配置、会话与关联日志…';
  $('diagnosis-actions').replaceChildren();
  try {
    const r = await api('diagnose', id ? { id } : {});
    if (seq !== diagnosisSeq) return;
    $('diagnosis-status').replaceChildren();
    if (r.thread) {
      const heading = document.createElement('p');
      heading.textContent =
        '会话：' +
        r.thread.title +
        '\n供应商：' +
        r.thread.provider +
        ' · 模型：' +
        (r.thread.model || '未知');
      $('diagnosis-status').append(heading);
    }
    for (const f of r.findings) {
      const item = document.createElement('div');
      item.className = 'finding ' + f.level;
      const title = document.createElement('b');
      title.textContent = f.title;
      const text = document.createElement('p');
      text.textContent = f.detail;
      item.append(title, text);
      $('diagnosis-status').append(item);
    }
    for (const a of r.actions)
      $('diagnosis-actions').append(rowButton(a.label, () => diagnosisAction(a), status));
  } catch (e) {
    if (seq === diagnosisSeq) $('diagnosis-status').textContent = e.message;
  }
}
$('diagnosis-details').ontoggle = async () => {
  if ($('diagnosis-details').open)
    try {
      await refreshThreads();
      await runDiagnosis();
    } catch (e) {
      $('diagnosis-status').textContent = e.message;
    }
};
$('threads-refresh').onclick = () =>
  busy($('threads-refresh'), async () => {
    await refreshThreads();
    await runDiagnosis();
  });
$('diagnosis-thread').onchange = runDiagnosis;
$('diagnosis-run').onclick = runDiagnosis;
refreshAccounts()
  .then(async (data) => {
    await refresh();
    const current = state.current.official && accountData?.items.find((a) => a.current);
    if (
      current &&
      (!current.quota || Date.now() - Date.parse(current.quota.checkedAt || 0) > 600000)
    )
      refreshQuota(current.id).catch((e) => accountStatus(e.message));
    if (data.login?.status === 'waiting' || switchPending()) watchAccounts();
  })
  .catch((e) => {
    $('summary').textContent = '本机配置读取失败';
    status(e.message);
  });
