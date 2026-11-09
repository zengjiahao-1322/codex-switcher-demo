// 用量页的纯数据换算：只依赖后台 usage 接口的字段，不碰页面元素。
// 字段约定：input 是未缓存的输入，cachedInput 是缓存读，cacheWrite 是缓存写，output 已含推理。

export const totalInput = (u) => u.input + u.cachedInput + u.cacheWrite;
export const totalTokens = (u) => totalInput(u) + u.output;

export function tokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

const symbols = { USD: 'US$', CNY: '¥' };
// cost 形如 { USD: 1.2, CNY: 0.3 }，只含实际出现过的币种；不到一分钱时多保留两位，免得显示成 0.00。
export function money(cost) {
  const parts = Object.entries(cost || {}).map(
    ([k, v]) => symbols[k] + v.toFixed(v > 0 && v < 0.01 ? 4 : 2),
  );
  return parts.length ? parts.join(' + ') : '—';
}
export const amount = (value, currency) => symbols[currency] + value.toFixed(4);

export const successRate = (t) =>
  t.requests ? (((t.requests - t.failed) / t.requests) * 100).toFixed(1) + '%' : '—';

export const isEmpty = (d) => d.totals.requests === 0 && d.untracked.requests === 0;

// Codex 的官方来源是某个 ChatGPT 账号；Claude Code 的官方来源就是它自己的登录。
export const kindLabel = (s, client) =>
  s.kind === 'api' ? 'API' : client === 'claude' ? '官方登录' : '官方账号';

// 项目列只显示文件夹名，完整路径放在悬停提示里。
export const folder = (cwd) => (cwd || '').split(/[\\/]/).filter(Boolean).at(-1) || '';

// 来源旁的计价说明：订阅折算 / 官方价 / 倍率 / 不计费。
export function pricingLabel(source, providers) {
  if (source.subscription) return '订阅折算';
  const pricing = providers.find((p) => p.id === source.id)?.pricing;
  if (pricing?.mode === 'free') return '不计费';
  if (pricing?.mode === 'multiplier')
    return `${pricing.multiplier} 倍 · ${pricing.currency === 'CNY' ? '人民币' : '美元'}`;
  return '官方价';
}

export function priceBookText(book) {
  const at = book.fetchedAt ? new Date(book.fetchedAt).toLocaleString('zh-CN', { hour12: false }) : '';
  if (book.error)
    return {
      warn: true,
      text: `价格更新失败（${book.error}）` + (at ? `，继续用 ${at} 的价格簿` : '，还没有可用的价格簿'),
    };
  return { warn: false, text: `价格簿 #${book.version} · 来自 OpenRouter · ${at} 更新` };
}

// 趋势图横轴：today 按小时，其余按天；点太多时隔几个显示一个标签。
export function axisLabel(at, index, range) {
  const d = new Date(at);
  if (range === 'today') return index % 3 === 0 ? String(d.getHours()).padStart(2, '0') + ':00' : '';
  if (range === '30d' && index % 5 !== 0) return '';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// 纵轴上限取整到一个好读的数，避免最高的柱子顶到边。
export function axisTop(series) {
  const max = Math.max(0, ...series.map(totalTokens));
  if (!max) return 1;
  const step = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / step) * step;
}

export const time = (t) =>
  new Date(t).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

export const duration = (ms) => (ms == null ? '—' : ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms');
