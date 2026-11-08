// Claude Code 页的数据整理。接入方式和不可用原因都由后端给出，这里只分组、拼文字，不做判断。
export const OFFICIAL = 'official';
export const accessLabels = { direct: '直连', adapter: '经本机转换' };

// 官方在最前；不可用的 API 按协议留在原组里置灰，方便用户找到它补密钥。
export function groups(claudeCode = {}, providers = []) {
  const result = [
    { key: OFFICIAL, items: [{ id: OFFICIAL, label: 'Claude 官方登录', selectable: true }] },
    { key: 'direct', items: [] },
    { key: 'adapter', items: [] },
  ];
  for (const provider of providers) {
    const access = claudeCode.providers?.find((item) => item.id === provider.id);
    if (!access) continue;
    const item = {
      ...provider,
      ...access,
      label: provider.name,
      selectable: access.access !== 'unavailable',
    };
    const direct =
      access.access === 'direct' ||
      (access.access === 'unavailable' && provider.apiMode === 'anthropic_messages');
    result[direct ? 1 : 2].items.push(item);
  }
  return result;
}
// 被外部改过（drift）时既不算接管某个 API，也不算回到官方。
export function isCurrent(id, claudeCode = {}) {
  return id === OFFICIAL
    ? !claudeCode.current && !claudeCode.drift
    : claudeCode.current?.providerId === id;
}
export function applyLabel(id, claudeCode = {}) {
  return isCurrent(id, claudeCode) ? '重新应用' : '用于 Claude Code';
}
export const host = (baseUrl = '') => baseUrl.replace(/^https?:\/\//, '').split('/')[0];
export const settingsPath = (claudeCode = {}) => (claudeCode.configDir || '~/.claude') + '\\settings.json';

// 状态卡和顶部切换共用的文字。
export function summary(claudeCode = {}) {
  const current = claudeCode.current;
  if (current)
    return {
      live: true,
      eyebrow: 'Claude Code 正在使用',
      title: current.label,
      detail: [
        accessLabels[current.access] || '',
        '主模型 ' + current.model,
        '快速模型 ' + (current.fastModel || '同主模型'),
      ]
        .filter(Boolean)
        .join(' · '),
      short: current.label + ' · ' + current.model,
    };
  if (claudeCode.drift)
    return {
      live: false,
      eyebrow: 'Claude Code',
      title: '配置已被外部修改',
      detail: claudeCode.drift,
      short: '配置已被外部修改',
    };
  return {
    live: false,
    eyebrow: 'Claude Code',
    title: 'Claude 官方登录',
    detail: '切换器没有接管，Claude Code 用你自己的登录',
    short: '官方登录（未接管）',
  };
}
export function currentFact(claudeCode = {}) {
  if (claudeCode.current) return '已接管 · ' + claudeCode.current.label;
  return claudeCode.drift ? '已被外部修改' : '未接管';
}
export function originalFact(original) {
  if (!original) return '—';
  return original.kind === 'custom'
    ? (original.host || '未知地址') + '（第三方网关）'
    : '官方登录（没有自定义地址）';
}
