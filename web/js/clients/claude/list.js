import { state } from '../../store.js';
const $ = (id) => document.getElementById(id);
import { status, tag } from '../../ui.js';
import { groups, applyLabel, isCurrent } from './model.js';
import { apply, autostart, models, probe, restore } from './actions.js';

let selected = 'official';
let cached = new Map();

function option(item, claudeCode, onPick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'source-card';
  button.setAttribute('role', 'radio');
  button.setAttribute('aria-checked', String(selected === item.id));
  button.disabled = !item.selectable;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = item.label;
  const detail = document.createElement('small');
  detail.textContent = item.blocked || item.model || (item.id === 'official' ? '恢复接管前的配置，不碰登录凭据' : '');
  button.append(name, detail);
  const suffix = isCurrent(item.id, claudeCode) ? tag('正在使用', 'done') : item.blocked ? tag(item.blocked, 'changed') : tag(item.access === 'adapter' ? '经本机转换' : '直连', item.access === 'adapter' ? 'adapter' : 'done');
  button.append(suffix);
  button.onclick = () => { selected = item.id; onPick(item); };
  return button;
}

export function renderClaudeList(claudeCode, providers, onPick) {
  const root = $('claude-list');
  if (!root) return;
  root.replaceChildren();
  for (const group of groups(claudeCode, providers)) {
    const heading = document.createElement('div');
    heading.className = 'group-label';
    heading.textContent = group.key === 'official' ? '官方' : group.key === 'direct' ? '直连 · Anthropic 协议' : '经本机转换 · OpenAI 协议';
    root.append(heading);
    for (const item of group.items) root.append(option(item, claudeCode, onPick));
  }
}

export async function renderClaudePanel(item, claudeCode, refresh) {
  const panel = $('claude-panel');
  if (!panel) return;
  panel.replaceChildren();
  const title = document.createElement('h3');
  title.textContent = item.label;
  panel.append(title);
  if (item.id === 'official') {
    const info = document.createElement('p');
    info.textContent = claudeCode.current ? `当前：已接管 · ${claudeCode.current.label}；接管前：${claudeCode.original?.host || '官方登录'}` : 'Claude Code 现在没有被切换器接管。';
    panel.append(info);
    const button = document.createElement('button');
    button.textContent = '恢复接管前的配置';
    button.disabled = !claudeCode.current;
    button.onclick = async () => { const result = await restore(); status(result.message); await refresh(); };
    panel.append(button);
    return;
  }
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = item.access === 'adapter' ? '经本机转换：切换器要保持运行；回复是整段返回，不会逐字显示。' : '直连：Claude Code 直接访问供应商。';
  panel.append(hint);
  if (item.access === 'adapter' && !claudeCode.autostart) {
    const start = document.createElement('button');
    start.textContent = '开启开机自启';
    start.onclick = async () => { await autostart(); await refresh(); };
    panel.append(start);
  }
  const model = document.createElement('input');
  model.value = item.model || '';
  model.setAttribute('aria-label', '主模型');
  const fast = document.createElement('input');
  fast.value = item.fastModel || '';
  fast.placeholder = '同主模型';
  fast.setAttribute('aria-label', '快速模型');
  const fetch = document.createElement('button');
  fetch.textContent = '获取模型';
  fetch.onclick = async () => { const result = await models(item.id); cached.set(item.id, result.models || []); status(result.message || '模型列表已更新'); };
  const actions = document.createElement('div');
  const use = document.createElement('button');
  use.textContent = applyLabel(item.id, claudeCode);
  use.onclick = async () => { const result = await apply(item.id, model.value.trim(), fast.value.trim()); status(result.message); await refresh(); };
  const check = document.createElement('button');
  check.textContent = '检测连接';
  check.onclick = async () => { const result = await probe(item.id, model.value.trim()); status(result.message); };
  actions.append(use, check);
  panel.append(document.createTextNode('主模型'), model, fetch, document.createTextNode('快速模型'), fast, actions);
}

export async function renderClaude(claudeCode, providers, refresh) {
  let item = groups(claudeCode, providers).flatMap((group) => group.items).find((entry) => entry.id === selected);
  if (!item) { selected = claudeCode.current?.providerId || 'official'; item = groups(claudeCode, providers).flatMap((group) => group.items).find((entry) => entry.id === selected) || { id: 'official', label: 'Claude 官方登录' }; }
  renderClaudeList(claudeCode, providers, (picked) => renderClaudePanel(picked, claudeCode, refresh));
  await renderClaudePanel(item, claudeCode, refresh);
}
