// Claude Code view data. Access decisions come from the backend.
export function groups(claudeCode = {}, providers = []) {
  const result = [{ key: 'official', items: [{ id: 'official', label: 'Claude 官方登录', selectable: true }] }, { key: 'direct', items: [] }, { key: 'adapter', items: [] }];
  for (const provider of providers) {
    const capability = claudeCode.providers?.find((item) => item.id === provider.id);
    if (!capability) continue;
    const item = { ...provider, ...capability, label: provider.name, selectable: capability.access !== 'unavailable' };
    const adapterGroup = item.access === 'adapter' || (item.access === 'unavailable' && provider.apiMode !== 'anthropic_messages');
    result[adapterGroup ? 2 : 1].items.push(item);
  }
  return result;
}
export function isCurrent(id, claudeCode = {}) {
  return id === 'official' ? !claudeCode.current : claudeCode.current?.providerId === id;
}
export function applyLabel(id, claudeCode = {}) {
  return isCurrent(id, claudeCode) ? '重新应用' : '用于 Claude Code';
}
