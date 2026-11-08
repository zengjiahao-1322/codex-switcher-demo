// Claude Code 页入口：组合状态卡、列表和详情，并记住选中项。只读 state，不判断规则。
import { state } from '../../store.js';
import { renderClaudeList } from './list.js';
import { renderClaudePanel } from './panel.js';
import { OFFICIAL, groups } from './model.js';
import { renderClaudeStatus } from './status.js';

let selected = null;

export function renderClaude(refresh) {
  const claudeCode = state.claudeCode,
    providers = state.providers.filter((p) => p.id !== OFFICIAL);
  const items = groups(claudeCode, providers).flatMap((group) => group.items);
  // 首次打开选中 Claude Code 正在用的；选中项被删除或变得不可选时回到同样的默认。
  const keep = items.find((item) => item.id === selected && item.selectable);
  const item =
    keep ||
    items.find((entry) => entry.id === claudeCode.current?.providerId) ||
    items.find((entry) => entry.id === OFFICIAL);
  selected = item.id;
  renderClaudeStatus(claudeCode, refresh);
  const pick = (id) => {
    selected = id;
    renderClaude(refresh);
  };
  renderClaudeList(claudeCode, providers, selected, pick);
  renderClaudePanel(item, claudeCode, state.adapter.port, refresh);
}
