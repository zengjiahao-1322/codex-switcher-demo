export function groups(claudeCode = {}, providers = []) {
  const result = [
    { key: 'official', items: [{ id: 'official', label: 'Claude 官方登录', access: 'direct', selectable: true }] },
    { key: 'direct', items: [] },
    { key: 'adapter', items: [] },
  ];
  for (const provider of providers) {
    if (provider.id === 'official') continue;
    const item = {
      ...provider,
      label: provider.name || provider.id,
      selectable: provider.access !== 'unavailable',
      blocked: provider.reason || null,
    };
    (item.access === 'adapter' ? result[2] : result[1]).items.push(item);
  }
  return result;
}

export function isCurrent(id, claudeCode = {}) {
  return id === 'official' ? !claudeCode.current : claudeCode.current?.providerId === id;
}

export function applyLabel(id, claudeCode = {}) {
  return isCurrent(id, claudeCode) ? '重新应用' : '用于 Claude Code';
}
