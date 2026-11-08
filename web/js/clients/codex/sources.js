import { $, api } from '../../api.js';
import { refresh } from '../../main.js';
import { accountData, hooks, modelCache, pendingRequests, state } from '../../store.js';
import { showTab } from '../../tabs.js';
import { busy, combo, merge, status, tag } from '../../ui.js';
import { sourceCard } from '../../components/source-card.js';

import {
  accountRemaining,
  accountWindow,
  accountPlan,
  accountStatus,
  ago,
  membership,
  membershipExpired,
  quotaRefreshing,
  refreshAccounts,
  refreshQuota,
  renderSelectedQuota,
  watchAccounts,
  windowName,
} from '../../views/accounts.js';
import { renderProviderList } from '../../views/providers.js';
export let topModels = [];
export const topCombo = combo($('model'), () => topModels);
export const officialTarget = () =>
  ['official'].includes($('provider').value) || $('provider').value.startsWith('account:');
export const selectedAccount = () =>
  accountData?.items.find((a) => 'account:' + a.id === $('provider').value);
export const selectedProvider = () =>
  state?.providers.find((p) => p.id === (officialTarget() ? 'official' : $('provider').value));
export const switchPending = () =>
  ['queued', 'preparing', 'switching', 'reopening'].includes(accountData?.switchJob?.status);
export async function confirmSwitchRestart(prefix) {
  const clients = await api('clients', {});
  const desktops = clients.clients?.filter((client) => client.kind === 'desktop') || [];
  const restartsDesktop =
    desktops.length > 0 &&
    desktops.every((client) => client.confirmed === true) &&
    desktops.some((client) => client.shared === true);
  if (!restartsDesktop) return true;
  return confirm(
    prefix +
      'Codex 桌面端会重启' +
      ($('reload-editors').checked ? '，已接入的编辑器窗口会重载' : '') +
      '，正在运行的任务会中断。',
  );
}
export function updateSwitchAction() {
  const p = selectedProvider(),
    a = selectedAccount(),
    official = officialTarget(),
    same = official
      ? state?.current.official && a?.current && !a?.pendingLogin
      : p?.inUse && $('model').value.trim() === state?.current.model;
  const locked = pendingRequests.has($('switch')) || switchPending();
  for (const card of $('source-list').querySelectorAll('.source-card')) card.disabled = locked;
  $('model').disabled = locked;
  $('fetch-models').disabled = locked || official || pendingRequests.has($('fetch-models'));
  $('probe').disabled = locked || official || pendingRequests.has($('probe'));
  $('probe').hidden = official;
  $('switch').disabled = locked || !p || (!official && !$('model').value.trim());
  $('switch').textContent = locked
    ? '正在切换…'
    : official && !a
      ? '添加官方账号'
      : same
        ? '重新应用'
        : '切换到这里';
}
export function selected(resetModel = true) {
  const p = selectedProvider(),
    official = officialTarget();
  if (resetModel) {
    $('model').value = (p?.inUse && state.current.model) || p?.model || '';
    topCombo.close();
  }
  topModels = merge(p?.models || [], modelCache.get(p?.id) || []);
  const source = sourceOptions.find((o) => o.value === $('provider').value);
  for (const card of $('source-list').querySelectorAll('.source-card'))
    card.setAttribute('aria-checked', String(card.dataset.source === $('provider').value));
  $('source-title').textContent = source ? source.name : '选择左侧的账号或 API';
  $('model-fields').hidden = official || !p;
  $('source-context').textContent =
    (official ? '使用 ChatGPT 官方服务和这个账号。' : '通过这个 API 使用所选模型。') +
    'Codex 桌面端在运行时会重启' +
    ($('reload-editors').checked ? '，已接入的编辑器窗口会重载' : '') +
    '，正在运行的任务会中断；已保存的对话不会被删除。';
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
// 来源列表：官方账号在前、自定义 API 在后，正在使用的排在各组第一；
// 来源较多时显示搜索和分类筛选。选中值存在隐藏的 #provider 中，其余逻辑按它读取。
export let sourceOptions = [];
let sourceFilter = 'all';
const filterLabels = { all: '全部', account: '官方账号', api: 'API' };
// 同一名称总是得到同一颜色，便于在长列表里区分首字母相同的来源。
function localCard(o) {
  const a = o.account,
    p = o.provider;
  return sourceCard(o, {
    checked: o.value === $('provider').value,
    using:
      a?.current && state.current.official
        ? tag(
            a.pendingLogin ? '登录已更新 · 待应用' : '正在使用',
            a.pendingLogin ? 'muted' : 'done',
          )
        : p?.inUse
          ? tag('正在使用', 'done')
          : null,
    model: p && ((p.inUse && state.current.model) || p.model),
    onPick: () => {
      status('');
      $('provider').value = o.value;
      selected();
      // 窄屏上详情在列表下方；宽屏时详情固定在旁边，不会滚动。
      $('source-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
  });
}
export function renderSources() {
  const items = accountData?.items || [],
    apis = state.providers.filter((p) => p.id !== 'official');
  const inUse = (o) =>
    Boolean(o.account ? o.account.current && state.current.official : o.provider?.inUse);
  sourceOptions = [
    ...(items.length
      ? items.map((a) => ({ value: 'account:' + a.id, name: a.label, kind: 'account', account: a }))
      : [{ value: 'official', name: 'ChatGPT 官方登录', kind: 'account' }]),
    ...apis.map((p) => ({ value: p.id, name: p.name, kind: 'api', provider: p })),
  ].sort((x, y) => (x.kind === 'api') - (y.kind === 'api') || inUse(y) - inUse(x));
  // 来源不多时一屏就能看完，不显示搜索和筛选。
  const many = sourceOptions.length > 5;
  if (!many) {
    sourceFilter = 'all';
    $('source-search').value = '';
  }
  $('source-search').hidden = !many;
  $('source-filter').hidden = !many;
  for (const button of $('source-filter').querySelectorAll('button')) {
    const key = button.dataset.filter,
      count = document.createElement('small');
    count.textContent = sourceOptions.filter((o) => key === 'all' || o.kind === key).length;
    button.replaceChildren(filterLabels[key], count);
    button.setAttribute('aria-pressed', String(key === sourceFilter));
  }
  const q = String($('source-search').value || '').trim().toLowerCase();
  const shown = sourceOptions.filter(
    (o) =>
      (sourceFilter === 'all' || o.kind === sourceFilter) &&
      (!q ||
        [o.name, o.account?.email, o.provider?.baseUrl, o.provider?.model]
          .filter(Boolean)
          .some((text) => text.toLowerCase().includes(q))),
  );
  $('source-list').replaceChildren();
  let group = '';
  for (const o of shown) {
    if (o.kind !== group) {
      group = o.kind;
      const label = document.createElement('div');
      label.className = 'group-label';
      label.append(group === 'account' ? '官方账号' : '自定义 API');
      // 一次刷新所有已保存账号的额度，各账号谁先返回先更新。
      if (group === 'account' && items.length) {
        const all = document.createElement('button');
        all.type = 'button';
        all.className = 'link';
        all.textContent = quotaRefreshing.size
          ? '正在刷新 ' + quotaRefreshing.size + ' 个…'
          : '全部刷新额度';
        all.disabled = quotaRefreshing.size > 0;
        all.onclick = () => refreshQuota().catch((e) => accountStatus(e.message));
        label.append(all);
      }
      $('source-list').append(label);
    }
    $('source-list').append(localCard(o));
  }
  if (!shown.length) {
    const empty = document.createElement('p');
    empty.className = 'group-label';
    empty.textContent = '没有匹配的账号或 API。';
    $('source-list').append(empty);
  }
  updateSwitchAction();
}
$('source-search').oninput = renderSources;
$('source-filter').onclick = (e) => {
  const key = e.target.closest('button')?.dataset.filter;
  if (!key) return;
  sourceFilter = key;
  renderSources();
};
// 列表按单选组的习惯用上下方向键移动选中项。
$('source-list').onkeydown = (e) => {
  if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
  e.preventDefault();
  const cards = [...$('source-list').querySelectorAll('.source-card')],
    i = cards.findIndex((c) => c.dataset.source === $('provider').value),
    next = cards[e.key === 'ArrowDown' ? Math.min(i + 1, cards.length - 1) : Math.max(i - 1, 0)];
  if (!next || next.disabled) return;
  next.click();
  next.focus();
};
export function renderSelect(keepDraft = false) {
  const keep = $('provider').value;
  renderSources();
  const items = accountData?.items || [],
    currentAccount = items.find((a) => a.current);
  const current = state.current.official
    ? currentAccount
      ? 'account:' + currentAccount.id
      : 'official'
    : state.providers.find((p) => p.id !== 'official' && p.inUse)?.id;
  const valid = sourceOptions.some((o) => o.value === keep),
    next = valid ? keep : current;
  $('provider').value = sourceOptions.some((o) => o.value === next)
    ? next
    : sourceOptions[0]?.value;
  selected(!(keepDraft && valid));
}
export function updateAccess(id, access) {
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

$('model').addEventListener('input', updateSwitchAction);
$('reload-editors').onchange = () => selected(false);
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
export function detectApi() {
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
// 旧对话一律跟随新来源，由后台默认处理，页面不再询问。
export async function startSwitch(route, input) {
  const r = await api(route, input);
  status(r.message);
  accountData.switchJob = { status: 'queued' };
  watchAccounts();
  await refreshAccounts();
}
$('switch').onclick = () =>
  busy($('switch'), async () => {
    const reloadEditors = $('reload-editors').checked;
    if (officialTarget()) {
      const a = selectedAccount();
      if (!a) {
        showTab('accounts');
        $('account-add').click();
        return;
      }
      if (!(await confirmSwitchRestart('切换到「' + a.label + '」？'))) return;
      status('正在准备应用账号…');
      await startSwitch('accountSwitch', { id: a.id, reloadEditors });
    } else {
      const provider = selectedProvider();
      if (!(await confirmSwitchRestart('切换到「' + provider.name + '」？'))) return;
      status('正在准备应用 API…');
      await startSwitch('desktopSwitch', {
        id: $('provider').value,
        model: $('model').value.trim(),
        reloadEditors,
      });
    }
  });
export function chooseSource(value, model) {
  $('provider').value = value;
  selected();
  if (model && !officialTarget()) {
    $('model').value = model;
    updateSwitchAction();
  }
  $('source-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
// 任一请求开始或结束时，同步切换按钮和“添加账号”的可用状态。
hooks.afterBusy = () => {
  $('account-add').disabled =
    accountData?.login?.status === 'waiting' ||
    switchPending() ||
    pendingRequests.has($('account-add'));
  if (state) updateSwitchAction();
};


