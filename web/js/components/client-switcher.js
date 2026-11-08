// 顶部客户端切换：每块显示该客户端当前在用什么。只负责显示和切换，文字由调用方传入。
import { $ } from '../api.js';

let selected = globalThis.localStorage?.getItem('selected-client') || 'codex';
export const selectedClient = () => selected;

// tiles: [{ key, label, detail, live }]；key 对应页面上的 <key>-status-card 和 <key>-chooser。
export function renderClientSwitcher(tiles, onSelect) {
  const root = $('client-switcher');
  root.replaceChildren();
  for (const tile of tiles) {
    const button = document.createElement('button'),
      name = document.createElement('b'),
      line = document.createElement('span'),
      dot = document.createElement('span');
    button.type = 'button';
    button.className = 'client-tab';
    button.dataset.client = tile.key;
    button.setAttribute('aria-pressed', String(selected === tile.key));
    name.textContent = tile.label;
    dot.className = 'live' + (tile.live ? '' : ' off');
    line.append(dot, tile.detail);
    button.append(name, line);
    button.onclick = () => {
      selected = tile.key;
      globalThis.localStorage?.setItem('selected-client', tile.key);
      onSelect();
    };
    root.append(button);
  }
  for (const tile of tiles) {
    $(tile.key + '-status-card').hidden = selected !== tile.key;
    $(tile.key + '-chooser').hidden = selected !== tile.key;
  }
}
