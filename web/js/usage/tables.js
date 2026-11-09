import { el, tag } from '../ui.js';
import {
  amount,
  duration,
  folder,
  kindLabel,
  money,
  pricingLabel,
  time,
  tokens,
  totalInput,
  totalTokens,
} from './model.js';

function table(headers, rows) {
  const t = el('table', 'usage-table');
  const head = el('tr');
  head.append(...headers.map(([text, num]) => el('th', num ? 'num' : null, text)));
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  tbody.append(...rows);
  t.append(thead, tbody);
  return t;
}
const cell = (text, num) => el('td', num ? 'num' : null, text);

export function renderSources(container, sources, providers, client) {
  const rows = sources.map((s) => {
    const name = el('td');
    const label = pricingLabel(s, providers);
    name.append(s.name, tag(kindLabel(s, client)), tag(label, label === '订阅折算' ? 'done' : null));
    // 网关自己的面板能看到首字延迟、TPS 和具体用的哪个号，链接紧跟在名称后面。
    if (s.usageUrl) {
      const a = el('a', 'usage-link', '网关面板 ↗');
      a.href = s.usageUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      name.append(a);
    }
    const requests = cell(String(s.requests), true);
    if (s.failed) requests.append(el('span', 'usage-muted', ` · 失败 ${s.failed}`));
    const row = el('tr');
    row.append(
      name,
      requests,
      cell(tokens(totalInput(s)), true),
      cell(tokens(s.output), true),
      cell(label === '不计费' ? '不计费' : money(s.cost), true),
    );
    return row;
  });
  container.replaceChildren(
    table([['来源'], ['请求', true], ['输入', true], ['输出', true], ['费用', true]], rows),
  );
}

export function renderModels(container, models) {
  const all = models.reduce((sum, m) => sum + totalTokens(m), 0) || 1;
  container.replaceChildren(
    ...models.map((m) => {
      const share = Math.round((totalTokens(m) / all) * 100);
      const row = el('div', 'usage-share-row');
      const bar = el('div', 'usage-track');
      const fill = el('i');
      fill.style.width = share + '%';
      bar.append(fill);
      row.append(
        el('span', null, m.model),
        el('small', null, `${share}% · ${m.requests} 次` + (m.priced ? '' : ' · 未定价')),
        bar,
      );
      return row;
    }),
  );
}

export function renderRequests(container, rows, client) {
  const codex = client === 'codex';
  const headers = [
    ['时间'],
    ['来源'],
    ['模型'],
    ...(codex ? [['思考强度']] : []),
    ['输入', true],
    ['缓存读', true],
    ...(codex ? [] : [['缓存写', true]]),
    ['输出', true],
    ['费用', true],
    ['耗时（估算）', true],
    ['项目'],
    ['结果'],
  ];
  const body = rows.map((r) => {
    const counts = (n) => cell(r.ok ? tokens(n) : '—', true);
    const result = el('td');
    if (r.ok) result.append(tag('成功', 'done'));
    else {
      const reason = el('span', 'usage-error', r.error || '');
      reason.title = r.error || '';
      result.append(tag('失败', 'changed'), reason);
    }
    const project = el('td', 'usage-muted', folder(r.project));
    project.title = r.project || '';
    const row = el('tr');
    row.append(
      cell(time(r.t)),
      cell(r.source.name),
      cell(r.model || '—'),
      ...(codex ? [cell(r.effort || '—')] : []),
      counts(r.input),
      counts(r.cachedInput),
      ...(codex ? [] : [counts(r.cacheWrite)]),
      counts(r.output),
      cell(r.cost == null ? '—' : amount(r.cost, r.currency), true),
      cell(duration(r.durationMs), true),
      project,
      result,
    );
    return row;
  });
  container.replaceChildren(table(headers, body));
}
