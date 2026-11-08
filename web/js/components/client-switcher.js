import { state } from '../store.js';
const $ = (id) => document.getElementById(id);
const storage = typeof localStorage === 'undefined' ? { getItem: () => null, setItem: () => {} } : localStorage;

export function selectedClient() {
  return storage.getItem('selected-client') || 'codex';
}

export function renderClientSwitcher(onChange = () => {}) {
  const root = $('client-switcher');
  if (!root) return;
  const active = selectedClient();
  root.replaceChildren();
  const codex = document.createElement('button');
  codex.type = 'button';
  codex.className = 'client-tab';
  codex.setAttribute('aria-pressed', String(active === 'codex'));
  codex.innerHTML = '<b>Codex</b><span>' + (state?.current?.model || '官方登录') + '</span>';
  const claude = document.createElement('button');
  claude.type = 'button';
  claude.className = 'client-tab';
  claude.setAttribute('aria-pressed', String(active === 'claude'));
  claude.innerHTML = '<b>Claude Code</b><span>' + (state?.claudeCode?.current?.label || '官方登录（未接管）') + '</span>';
  for (const [button, key] of [[codex, 'codex'], [claude, 'claude']]) {
    button.onclick = () => {
      storage.setItem('selected-client', key);
      renderClientSwitcher(onChange);
      onChange(key);
    };
    root.append(button);
  }
}

export function renderClientVisibility() {
  const claude = selectedClient() === 'claude';
  for (const id of ['codex-status-card', 'codex-chooser']) if ($(id)) $(id).hidden = claude;
  for (const id of ['claude-status-card', 'claude-chooser']) if ($(id)) $(id).hidden = !claude;
}
