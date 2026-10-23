import { $, api, sessionLost } from './api.js';
import { accountData, setState, state } from './store.js';
import { providerStatus, status } from './ui.js';
import {
  accountStatus,
  refreshAccounts,
  refreshQuota,
  renderAccounts,
  watchAccounts,
} from './views/accounts.js';
import { refreshClients, renderDiagnosis } from './views/diagnostics.js';
import { renderProviderList } from './views/providers.js';
import { renderService } from './views/settings.js';
import { renderSelect, switchPending } from './views/sources.js';
import { renderEffect, renderSummary } from './views/status.js';
import { checkUpdate, renderUpdate } from './views/update.js';

// 页面入口：各分区的渲染和事件在 views/ 下，共享数据在 store.js，请求与会话在 api.js。
export async function refresh() {
  setState(await api('state'));
  $('app-version').textContent = state.build
    ? '版本 ' + state.build.version + ' · 构建 ' + state.build.id
    : '后台构建未知，请重新启动新版切换器';
  renderEffect();
  renderDiagnosis();
  renderSummary();
  renderService();
  renderProviderList();
  renderSelect(true);
  renderAccounts();
  renderUpdate(state.update);
  $('usage-notice').hidden = !state.usage?.notice;
  $('usage-notice').textContent = state.usage?.notice || '';
  const protection = state.dataDirProtection;
  $('protection-notice').hidden = protection.ok;
  $('protection-notice').textContent = protection.ok
    ? ''
    : '未能限制数据目录的访问权限，本机其他用户可能读到保存的登录凭证。建议把切换器放在你自己的用户目录下再启动。\n' +
      protection.error;
  if (state.notice) providerStatus(state.notice);
}
// 首屏三个请求互不依赖，同时发出。全部结束后再处理失败，
// 避免先返回的失败提示被后返回的成功渲染覆盖（结果不能取决于返回顺序）。
Promise.allSettled([refreshAccounts(), refresh(), refreshClients()]).then(([accounts, loaded]) => {
  const failure = [accounts, loaded].find((r) => r.status === 'rejected');
  if (failure) {
    $('summary').textContent = sessionLost ? '未连接本机会话' : '本机配置读取失败';
    if (!sessionLost) status(failure.reason.message);
    return;
  }
  const current = state.current.official && accountData?.items.find((a) => a.current);
  if (current && (!current.quota || Date.now() - Date.parse(current.quota.checkedAt || 0) > 600000))
    refreshQuota(current.id).catch((e) => accountStatus(e.message));
  if (accounts.value.login?.status === 'waiting' || switchPending()) watchAccounts();
  // 首屏完成后再检查更新，不拖慢首屏。
  checkUpdate().catch((e) => ($('update-status').textContent = e.message));
});
