// Claude Code 页的来源列表：沿用共享的来源卡片，标签按 Claude Code 自己的接入方式显示。
import { $ } from '../../api.js';
import { tag } from '../../ui.js';
import { sourceCard } from '../../components/source-card.js';
import { OFFICIAL, accessLabels, groups, isCurrent } from './model.js';

const groupNames = {
  [OFFICIAL]: '官方',
  direct: '直连 · Anthropic 协议',
  adapter: '经本机转换 · OpenAI 协议',
};
const tagClass = { direct: 'done', adapter: 'custom' };

function card(item, claudeCode, selected, onPick) {
  const tags = [];
  if (item.id !== OFFICIAL)
    tags.push(
      item.selectable
        ? tag(accessLabels[item.access], tagClass[item.access])
        : tag(item.reason, 'changed'),
    );
  if (isCurrent(item.id, claudeCode)) tags.push(tag('正在使用', 'done'));
  return sourceCard(
    { value: item.id, name: item.label, provider: item.id === OFFICIAL ? null : item },
    {
      checked: item.id === selected,
      // 不可用的原因已在标签里，说明行和其他卡片一样显示地址和模型。
      blocked: item.selectable ? '' : item.reason,
      tags,
      detail:
        item.id === OFFICIAL
          ? '恢复接管前的配置，不碰登录凭据'
          : item.baseUrl.replace(/^https?:\/\//, '') + ' · ' + (item.model || '默认模型'),
      onPick: () => onPick(item.id),
    },
  );
}

export function renderClaudeList(claudeCode, providers, selected, onPick) {
  const root = $('claude-list');
  root.replaceChildren();
  for (const group of groups(claudeCode, providers)) {
    if (group.key !== OFFICIAL && !group.items.length) continue;
    const label = document.createElement('div');
    label.className = 'group-label';
    label.append(groupNames[group.key]);
    if (group.key === 'adapter') {
      const note = document.createElement('small');
      note.textContent = '需保持切换器运行';
      label.append(note);
    }
    root.append(label);
    for (const item of group.items) root.append(card(item, claudeCode, selected, onPick));
  }
}
