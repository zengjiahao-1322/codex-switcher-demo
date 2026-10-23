import { $, api } from '../api.js';
import { accountData, hooks, modelCache, pendingRequests, state } from '../store.js';
import { showTab } from '../tabs.js';
import { accessTag, busy, combo, merge, status, tag } from '../ui.js';
import {
  accountRemaining,
  refreshAccounts,
  renderSelectedQuota,
  watchAccounts,
} from './accounts.js';
import { renderProviderList } from './providers.js';

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
    '切换后 Codex 桌面端会重启' +
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
// 来源卡片：官方账号在前、自定义 API 在后；选中值存在隐藏的 #provider 中，其余逻辑按它读取。
export let sourceOptions = [];
export function renderSources() {
  const items = accountData?.items || [],
    apis = state.providers.filter((p) => p.id !== 'official');
  sourceOptions = [
    ...(items.length
      ? items.map((a) => ({
          value: 'account:' + a.id,
          name: a.label,
          group: '官方账号',
          account: a,
        }))
      : [{ value: 'official', name: 'ChatGPT 官方登录', group: '官方账号' }]),
    ...apis.map((p) => ({ value: p.id, name: p.name, group: '自定义 API', provider: p })),
  ];
  $('source-list').replaceChildren();
  let group = '';
  for (const o of sourceOptions) {
    if (o.group !== group) {
      group = o.group;
      const label = document.createElement('p');
      label.className = 'group-label';
      label.textContent = group;
      $('source-list').append(label);
    }
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'source-card';
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', String(o.value === $('provider').value));
    card.dataset.source = o.value;
    // 首字母图标 + 名称行（名称与标签）+ 说明行。
    const avatar = document.createElement('span'),
      body = document.createElement('span'),
      head = document.createElement('span'),
      name = document.createElement('span'),
      detail = document.createElement('small');
    avatar.className = 'avatar' + (o.provider ? ' api' : '');
    avatar.textContent = o.name.trim().charAt(0).toUpperCase();
    body.className = 'body';
    head.className = 'head';
    name.className = 'name';
    name.textContent = o.name;
    head.append(name);
    const a = o.account,
      p = o.provider;
    if (a) {
      head.append(tag(a.plan));
      if (a.current && state.current.official)
        head.append(
          tag(
            a.pendingLogin ? '登录已更新 · 待应用' : '正在使用',
            a.pendingLogin ? 'muted' : 'done',
          ),
        );
      const remaining = accountRemaining(a);
      if (remaining !== null)
        head.append(tag('剩余 ' + Math.round(remaining) + '%', remaining > 20 ? '' : 'changed'));
      detail.textContent = a.label === a.email ? 'ChatGPT 官方账号' : a.email;
    } else if (p) {
      head.append(accessTag(p));
      if (!p.hasKey && !p.local) head.append(tag('缺少密钥', 'changed'));
      if (p.inUse) head.append(tag('正在使用', 'done'));
      detail.textContent =
        p.baseUrl.replace(/^https?:\/\//, '') +
        ' · ' +
        ((p.inUse && state.current.model) || p.model);
    } else detail.textContent = '还没有保存的账号，选中后可添加';
    body.append(head, detail);
    card.append(avatar, body);
    card.onclick = () => {
      status('');
      $('provider').value = o.value;
      selected();
      // 窄屏上详情在卡片列表下方；宽屏时详情固定在旁边，不会滚动。
      $('source-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    $('source-list').append(card);
  }
  updateSwitchAction();
}
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
      status('正在准备应用账号…');
      await startSwitch('accountSwitch', { id: a.id, reloadEditors });
    } else {
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
