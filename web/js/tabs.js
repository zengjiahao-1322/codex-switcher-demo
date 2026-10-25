import { $ } from './api.js';
import { accountData } from './store.js';
import { accountStatus, refreshQuota } from './views/accounts.js';
import { refreshClients } from './views/diagnostics.js';

// 管理分页默认收起，打开时才读取对应数据；再次点击当前分页收起。
export const tabPanels = {
  accounts: 'account-manager',
  apis: 'api-manager',
  editors: 'client-details',
  remotes: 'remote-panel',
  settings: 'settings-panel',
};
export let activeTab = null,
  clientsTimer = null;
export function showTab(name, toggle = false) {
  const next = toggle && activeTab === name ? null : name;
  for (const [key, panel] of Object.entries(tabPanels)) {
    $('tab-' + key).setAttribute('aria-selected', String(key === next));
    $(panel).hidden = key !== next;
  }
  if (next === activeTab) return;
  activeTab = next;
  clearInterval(clientsTimer);
  clientsTimer = null;
  // 编辑器和远程服务器都来自运行状态，打开时每 5 秒刷新；页面不可见时不刷新（后台每次都要扫描进程）。
  if (next === 'editors' || next === 'remotes') {
    refreshClients();
    clientsTimer = setInterval(() => document.hidden || refreshClients(), 5000);
  }
  // 每读一个账号额度都要启动一个官方 Codex 进程；只在读数超过 10 分钟时自动刷新，和首屏一致。
  if (
    next === 'accounts' &&
    accountData?.items.some(
      (a) => !a.quota || Date.now() - Date.parse(a.quota.checkedAt || 0) > 600000,
    )
  )
    refreshQuota().catch((e) => accountStatus(e.message));
}
for (const key of Object.keys(tabPanels)) $('tab-' + key).onclick = () => showTab(key, true);
// 回到页面时立即刷新一次，不必等下一个 5 秒。
document.onvisibilitychange = () => {
  if (!document.hidden && clientsTimer) refreshClients();
};
