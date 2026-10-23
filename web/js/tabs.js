import { $ } from './api.js';
import { accountData } from './store.js';
import { accountStatus, refreshQuota } from './views/accounts.js';
import { refreshClients } from './views/diagnostics.js';

// 管理分页默认收起，打开时才读取对应数据；再次点击当前分页收起。
export const tabPanels = {
  accounts: 'account-manager',
  apis: 'api-manager',
  editors: 'client-details',
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
  if (next === 'editors') {
    refreshClients();
    clientsTimer = setInterval(refreshClients, 5000);
  }
  if (
    next === 'accounts' &&
    accountData?.items.some(
      (a) => !a.quota || Date.now() - Date.parse(a.quota.checkedAt || 0) > 60000,
    )
  )
    refreshQuota().catch((e) => accountStatus(e.message));
}
for (const key of Object.keys(tabPanels)) $('tab-' + key).onclick = () => showTab(key, true);
