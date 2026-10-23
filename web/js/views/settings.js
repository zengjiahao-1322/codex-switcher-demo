import { $, api } from '../api.js';
import { refresh } from '../main.js';
import { state } from '../store.js';
import { busy, status } from '../ui.js';

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
