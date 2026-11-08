import { $ } from '../api.js';
import { state } from '../store.js';
let selected = globalThis.localStorage?.getItem('selected-client') || 'codex';
export const selectedClient = () => selected;
export function renderClientVisibility() {
  const claude = selected === 'claude';
  $('codex-status-card').hidden = $('codex-chooser').hidden = claude;
  $('claude-status-card').hidden = $('claude-chooser').hidden = !claude;
}
export function renderClientSwitcher(onChange) {
  const root = $('client-switcher');
  root.replaceChildren();
  const current = state.current;
  const provider = state.providers.find((item) => item.inUse);
  const cc = state.claudeCode?.current;
  for (const [key, label, detail] of [
    ['codex', 'Codex', (current.official ? '官方登录' : provider?.name || '自定义 API') + (current.model ? ' · ' + current.model : '')],
    ['claude', 'Claude Code', cc ? cc.label + ' · ' + cc.model : '官方登录（未接管）'],
  ]) {
    const button = document.createElement('button'), name = document.createElement('b'), summary = document.createElement('span');
    button.type = 'button';
    button.className = 'client-tab';
    button.dataset.client = key;
    button.setAttribute('aria-pressed', String(selected === key));
    name.textContent = label;
    summary.textContent = detail;
    button.append(name, summary);
    button.onclick = () => {
      selected = key;
      globalThis.localStorage?.setItem('selected-client', key);
      renderClientSwitcher(onChange);
      renderClientVisibility();
      onChange();
    };
    root.append(button);
  }
  renderClientVisibility();
  if (selected === 'claude') onChange();
}
