import { $, api } from '../api.js';
import { rowButton, status } from '../ui.js';
import { startSwitch, switchPending } from './sources.js';

// 配置备份：切换器改写本机 Codex 配置前自动保存的副本（不含登录），在设置里查看和恢复。
const reasons = { switch: '切换前', official: '切回官方前', restore: '恢复备份前' };
const stamp = (iso) =>
  new Date(iso).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
export async function refreshBackups() {
  const { items } = await api('backups', {});
  const list = $('backup-list');
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'note';
    empty.textContent = '还没有备份。第一次切换时会自动创建。';
    list.append(empty);
    return;
  }
  for (const b of items) {
    const row = document.createElement('div'),
      info = document.createElement('div'),
      summary = document.createElement('small');
    row.className = 'prow';
    info.className = 'account-info';
    info.append(document.createTextNode(stamp(b.at) + ' · ' + (reasons[b.reason] || b.reason)));
    summary.textContent = b.summary;
    info.append(summary);
    const restore = rowButton(
      '恢复',
      async () => {
        if (
          !confirm(
            '把本机 Codex 配置恢复到 ' +
              stamp(b.at) +
              ' 的备份（' +
              b.summary +
              '）？恢复前会先备份当前配置，登录的账号不变。Codex 桌面端会重启' +
              ($('reload-editors').checked ? '，已接入的编辑器窗口会重载' : '') +
              '，正在运行的任务会中断。',
          )
        )
          return;
        status('正在恢复配置备份…');
        await startSwitch('restoreBackup', {
          id: b.id,
          reloadEditors: $('reload-editors').checked,
        });
        await refreshBackups();
      },
      status,
    );
    restore.disabled = switchPending();
    row.append(info, restore);
    list.append(row);
  }
}
