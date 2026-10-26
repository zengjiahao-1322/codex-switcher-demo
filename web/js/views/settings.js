import { $, api } from '../api.js';
import { refresh } from '../main.js';
import { state } from '../store.js';
import { busy, status } from '../ui.js';

function finished(title, text) {
  const main = document.querySelector('main'),
    card = document.createElement('section');
  card['className'] = 'card lifecycle-finished';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const note = document.createElement('p');
  note.textContent = text;
  card['append'](heading, note);
  main.replaceChildren(card);
}

export function renderService() {
  const a = state.adapter;
  $('autostart').checked = !!a.autostart;
  $('service').textContent = a.ready
    ? '转换服务运行中 · 端口 ' + a.port
    : '转换服务未运行或端口 ' + a.port + ' 被占用。';
}
$('autostart').onchange = () =>
  busy($('autostart'), async () => {
    const r = await api('autostart', { enabled: $('autostart').checked });
    status(r.message);
    await refresh();
  });
$('app-quit').onclick = () => {
  if (!confirm('退出后切换和 API 转换服务都会停止，确定退出吗？')) return;
  busy($('app-quit'), async () => {
    await api('quit', {});
    finished('切换器已退出', '双击桌面图标即可重新打开。');
  });
};
$('app-uninstall').onclick = () => {
  const panel = $('uninstall-panel');
  panel.hidden = false;
  panel.replaceChildren();
  const text = document.createElement('p');
  text.textContent =
    '将删除程序文件、桌面图标、开机自启和“已安装的应用”登记；不会删除 Codex 登录和对话。';
  const label = document.createElement('label');
  label['className'] = 'check';
  const keep = document.createElement('input');
  keep.type = 'checkbox';
  keep.checked = true;
  label['append'](keep, document.createTextNode('保留账号与设置数据（重新安装后可直接使用）'));
  const actions = document.createElement('div');
  actions['className'] = 'actions';
  const confirmButton = document.createElement('button');
  confirmButton.className = 'danger-text';
  confirmButton.textContent = '确认卸载';
  confirmButton.onclick = () =>
    busy(confirmButton, async () => {
      await api('uninstall', { keepData: keep.checked });
      finished('正在卸载', '完成后可关闭本页。');
    });
  const cancel = document.createElement('button');
  cancel.textContent = '取消';
  cancel.onclick = () => (panel.hidden = true);
  actions['append'](confirmButton, cancel);
  panel.append(text, label, actions);
};
