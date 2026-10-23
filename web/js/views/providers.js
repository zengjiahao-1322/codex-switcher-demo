import { $, api } from '../api.js';
import { refresh } from '../main.js';
import { modelCache, state } from '../store.js';
import { showTab } from '../tabs.js';
import {
  accessTag,
  busy,
  combo,
  merge,
  modeLabels,
  providerStatus,
  rowButton,
  tag,
} from '../ui.js';
import { selected } from './sources.js';

export let editing = null,
  formModels = [];
combo($('pf-model'), () => formModels);
export function renderProviderList() {
  const providers = state.providers.filter((p) => p.id !== 'official');
  $('provider-list').replaceChildren();
  $('list-count').textContent = '共 ' + providers.length + ' 个配置';
  $('api-count').textContent = providers.length;
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
export let pickerModels = [],
  formRevision = 0;
export const formContext = () =>
  JSON.stringify([formRevision, editing, $('pf-url').value, $('pf-mode').value, $('pf-key').value]);
export const extraModels = () =>
  $('pf-models')
    .value.split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
export function renderPicker() {
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
export function resetPicker() {
  formRevision++;
  pickerModels = [];
  formModels = [];
  $('pf-picker').hidden = true;
  $('pf-filter').value = '';
}
export function resetForm() {
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
export function startEdit(p) {
  providerStatus('');
  showTab('apis');
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
