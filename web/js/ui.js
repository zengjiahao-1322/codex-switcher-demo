import { $ } from './api.js';
import { hooks, pendingRequests } from './store.js';

export const status = (s) => {
  $('status').textContent = s;
};
export const providerStatus = (s) => {
  $('provider-status').hidden = !s;
  $('provider-status').textContent = s || '';
};
export async function busy(button, fn, report = status) {
  pendingRequests.add(button);
  button.disabled = true;
  hooks.afterBusy();
  try {
    await fn();
  } catch (e) {
    report('失败：' + e.message);
  } finally {
    pendingRequests.delete(button);
    button.disabled = false;
    hooks.afterBusy();
  }
}
export function tag(text, cls) {
  const t = document.createElement('span');
  t.className = 'tag' + (cls ? ' ' + cls : '');
  t.textContent = text;
  return t;
}
export const modeLabels = {
  responses: 'Responses',
  chat_completions: 'Chat Completions',
  anthropic_messages: 'Anthropic',
};
// 接入方式（最近一次检测）：直连 = Codex 直接访问；经本机转换 = 经本工具 127.0.0.1 转换服务。
export const accessLabels = {
  official: ['官方登录', 'official'],
  direct: ['直连', 'done'],
  adapter: ['经本机转换', 'custom'],
  failed: ['未通过', 'changed'],
  unknown: ['未检测', 'muted'],
};
export const accessOf = (p) => accessLabels[p.access?.mode] || accessLabels.unknown;
export const accessTag = (p) => {
  const [t, c] = accessOf(p);
  const el = tag(t, c);
  if (p.access?.at)
    el.title = `${new Date(p.access.at).toLocaleString('zh-CN')} 检测（模型 ${p.access.model}）：${p.access.message || ''}`;
  return el;
};

// 模型下拉框：点开/聚焦显示全部（当前项高亮）；输入时按 开头匹配 > 分段开头匹配 > 包含匹配 排序并高亮；无匹配时提示将使用输入的名称。
export function combo(input, getOptions) {
  const list = document.createElement('div');
  list.className = 'combo-list';
  list.hidden = true;
  list.setAttribute('role', 'listbox');
  input.parentElement.append(list);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  let items = [],
    active = -1,
    showAll = false,
    picking = false;
  const LIMIT = 300;
  const rank = (m, q) => {
    const s = m.toLowerCase();
    if (s === q) return 0;
    if (s.startsWith(q)) return 1;
    if (s.split(/[-_/.:~@ ]+/).some((part) => part.startsWith(q))) return 2;
    return s.includes(q) ? 3 : -1;
  };
  const note = (text) => {
    const n = document.createElement('div');
    n.className = 'combo-note';
    n.textContent = text;
    list.append(n);
  };
  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  }
  function highlight(el, m, q) {
    const i = q ? m.toLowerCase().indexOf(q) : -1;
    if (i < 0) {
      el.textContent = m;
      return;
    }
    const b = document.createElement('b');
    b.textContent = m.slice(i, i + q.length);
    el.append(m.slice(0, i), b, m.slice(i + q.length));
  }
  function render() {
    const all = getOptions(),
      value = input.value.trim(),
      q = showAll ? '' : value.toLowerCase();
    items = q
      ? all
          .map((m) => [m, rank(m, q)])
          .filter((x) => x[1] >= 0)
          .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
          .map((x) => x[0])
      : [...all];
    list.replaceChildren();
    if (!all.length) note('还没有模型列表：点右侧按钮获取，或直接输入模型名称。');
    else if (!items.length) note(`没有匹配“${value}”的模型，将直接使用你输入的名称。`);
    else {
      if (q) note(`匹配 ${items.length} / ${all.length} 个模型`);
      items.slice(0, LIMIT).forEach((m, i) => {
        const el = document.createElement('div');
        el.className =
          'combo-item' + (m === value ? ' current' : '') + (i === active ? ' active' : '');
        el.setAttribute('role', 'option');
        highlight(el, m, q);
        el.onmousedown = (e) => {
          e.preventDefault();
          pick(m);
        };
        list.append(el);
      });
      if (items.length > LIMIT) note(`仅显示前 ${LIMIT} 个，请输入关键字缩小范围。`);
    }
    list.style.pointerEvents = items.length ? '' : 'none';
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    const cur = list.querySelector('.active') || (showAll ? list.querySelector('.current') : null);
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  function pick(m) {
    picking = true;
    input.value = m;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    picking = false;
    close();
  }
  input.addEventListener('focus', () => {
    showAll = true;
    active = -1;
    render();
  });
  input.addEventListener('click', () => {
    if (list.hidden) {
      showAll = true;
      render();
    }
  });
  input.addEventListener('input', () => {
    if (picking) return;
    showAll = false;
    active = -1;
    render();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) {
        showAll = true;
        render();
      }
      const n = Math.min(items.length, LIMIT);
      if (!n) return;
      active = e.key === 'ArrowDown' ? (active + 1) % n : active <= 0 ? n - 1 : active - 1;
      render();
      return;
    }
    if (e.key === 'Enter' && !list.hidden && active >= 0 && items[active]) {
      e.preventDefault();
      pick(items[active]);
    }
  });
  return { close };
}
export const merge = (a, b) => [...new Set([...a, ...b])].sort((x, y) => x.localeCompare(y));
export function rowButton(text, fn, report = providerStatus) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.onclick = () => busy(b, fn, report);
  return b;
}
