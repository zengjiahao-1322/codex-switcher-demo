// Claude Code 状态卡。全局的 #status 在 Codex 状态卡里，切到本页时看不到，所以本页有自己的状态行。
import { $ } from '../../api.js';
import { busy } from '../../ui.js';
import { restore } from './actions.js';
import { settingsPath, summary } from './model.js';

export const claudeStatus = (text) => {
  $('claude-status').textContent = text;
};

export function renderClaudeStatus(claudeCode, refresh) {
  const view = summary(claudeCode);
  $('claude-live').className = 'live' + (view.live ? '' : ' off');
  $('claude-eyebrow').textContent = view.eyebrow;
  const title = document.createElement('b'),
    detail = document.createElement('small');
  title.textContent = view.title;
  detail.textContent = view.detail;
  $('claude-summary').replaceChildren(title, detail);

  const line = $('claude-line');
  line.replaceChildren();
  if (claudeCode.original) {
    const text = document.createElement('span'),
      button = document.createElement('button');
    text.textContent = claudeCode.current
      ? '写在 ' + settingsPath(claudeCode) + '，新开的 Claude Code 会话生效'
      : '可以恢复成切换器接管前的样子';
    button.type = 'button';
    button.className = 'link';
    button.textContent = '恢复接管前的配置';
    button.onclick = () =>
      busy(
        button,
        async () => {
          const result = await restore();
          await refresh();
          claudeStatus(result.message);
        },
        claudeStatus,
      );
    line.append(text, button);
  } else {
    line.textContent = '从下面选一个 API 交给 Claude Code。只改 Claude Code 的配置，Codex 不受影响。';
  }
}
