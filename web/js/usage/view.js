import { $ } from '../api.js';
import { state as app } from '../store.js';
import { busy, el } from '../ui.js';
import * as actions from './actions.js';
import { renderChart, renderLegend } from './chart.js';
import {
  isEmpty,
  money,
  priceBookText,
  successRate,
  tokens,
  totalInput,
  totalTokens,
} from './model.js';
import { renderModels, renderRequests, renderSources } from './tables.js';

// 用量分页：顶部选客户端和时间范围，汇总来自 usage，明细来自 usageRequests（筛选只作用于明细）。
const PAGE = 100;
const view = { client: 'codex', range: '7d', source: '', model: '', result: '', offset: 0 };

const report = (text) => {
  $('usage-status').hidden = !text;
  $('usage-status').textContent = text || '';
};

function seg(container, key, items, current, pick) {
  container.replaceChildren(
    ...items.map(([value, label]) => {
      const b = el('button', null, label);
      b.type = 'button';
      b.dataset[key] = value;
      b.setAttribute('aria-pressed', String(value === current));
      b.onclick = () => pick(value);
      return b;
    }),
  );
}
function options(select, items, current) {
  select.replaceChildren(
    ...items.map(([value, label]) => {
      const o = el('option', null, label);
      o.value = value;
      return o;
    }),
  );
  select.value = current;
}

function renderBar() {
  seg($('usage-client'), 'usageClient', [['codex', 'Codex'], ['claude', 'Claude Code']], view.client, (v) => {
    Object.assign(view, { client: v, source: '', model: '', result: '', offset: 0 });
    openUsage();
  });
  seg($('usage-range'), 'usageRange', [['today', '今天'], ['7d', '7 天'], ['30d', '30 天']], view.range, (v) => {
    Object.assign(view, { range: v, offset: 0 });
    openUsage();
  });
}

function tile(label, value, detail) {
  const t = el('div', 'usage-tile');
  t.append(el('small', null, label), el('b', null, value), el('span', null, detail));
  return t;
}

function renderSummary(d) {
  const book = priceBookText(d.priceBook);
  $('usage-pricebook').textContent = book.text;
  $('usage-pricebook').className = 'usage-book' + (book.warn ? ' warn' : '');
  const name = view.client === 'codex' ? 'Codex' : 'Claude Code';
  $('usage-empty').hidden = !isEmpty(d);
  $('usage-content').hidden = isEmpty(d);
  if (isEmpty(d)) {
    $('usage-empty').textContent = `还没有 ${name} 用量记录。用过之后这里会显示每次请求的 token 和费用；第一次打开可能要几秒建立索引。`;
    $('usage-hints').replaceChildren();
    return;
  }
  const t = d.totals;
  const hints = [];
  if (d.untracked.requests) {
    const since = new Date(d.trackedSince).toLocaleString('zh-CN', { hour12: false });
    hints.push(
      el(
        'p',
        'hint info',
        `切换记录从 ${since} 开始，之前的 ${d.untracked.requests} 次请求（${tokens(totalTokens(d.untracked))} token）归为“切换记录开始之前”，不计入来源。`,
      ),
    );
  }
  if (t.unpriced) {
    const names = d.models.filter((m) => !m.priced).map((m) => m.model).join('、');
    hints.push(
      el(
        'p',
        'hint warn',
        `有 ${t.unpriced} 次请求没找到价格（${names}），费用里不含这部分。可以在 API 配置里把它设成“不计费”或“按倍率”。`,
      ),
    );
  }
  $('usage-hints').replaceChildren(...hints);

  const top = d.models[0];
  const reads = [`缓存读 ${tokens(t.cachedInput)}`, ...(t.cacheWrite ? [`缓存写 ${tokens(t.cacheWrite)}`] : [])];
  $('usage-tiles').replaceChildren(
    tile(
      '总 token',
      tokens(totalTokens(t)),
      `输入 ${tokens(totalInput(t))}（${reads.join(' · ')}） · 输出 ${tokens(t.output)}` +
        (t.reasoning ? `（含推理 ${tokens(t.reasoning)}）` : ''),
    ),
    tile(
      '估算费用',
      money(t.cost),
      `已定价 ${t.priced} / ${t.requests} 次` + (d.sources.some((s) => s.subscription) ? ' · 含订阅折算' : ''),
    ),
    tile('请求', String(t.requests), `成功率 ${successRate(t)} · 失败 ${t.failed}`),
    tile('最常用模型', top ? top.model : '—', top ? `${top.requests} 次 · ${tokens(totalTokens(top))} token` : ''),
  );

  $('usage-grain').textContent = view.range === 'today' ? '按小时' : '按天';
  renderLegend($('usage-legend'), d.series);
  renderChart($('usage-chart'), d.series, view.range);
  renderSources($('usage-sources'), d.sources, app.providers, view.client);
  renderModels($('usage-models'), d.models);
  options(
    $('req-source'),
    [
      ['', '全部来源'],
      ...d.sources.map((s) => [s.key, s.name]),
      ...(d.untracked.requests ? [['untracked', '切换记录开始之前']] : []),
    ],
    view.source,
  );
  options($('req-model'), [['', '全部模型'], ...d.models.map((m) => [m.model, m.model])], view.model);
  options($('req-result'), [['', '全部结果'], ['ok', '成功'], ['failed', '失败']], view.result);
  $('usage-foot').textContent =
    `数据来自本机 ${name} 的记录，只读用量、时间、模型和错误类型，不读对话内容。` +
    '费用按当前价格簿估算，官方账号为订阅折算，不是实际扣费。首字延迟、TPS 和网关内部用的是哪个号，请在网关自己的面板里看。';
}

async function loadRequests() {
  const query = { client: view.client, range: view.range, offset: view.offset, limit: PAGE };
  if (view.source) query.source = view.source;
  if (view.model) query.model = view.model;
  if (view.result) query.result = view.result;
  const r = await actions.requests(query);
  renderRequests($('usage-requests'), r.rows, view.client);
  const end = view.offset + r.rows.length;
  $('req-range').textContent = r.total ? `${view.offset + 1}–${end} / ${r.total}` : '没有符合条件的请求';
  $('req-prev').disabled = view.offset === 0;
  $('req-next').disabled = end >= r.total;
}

// 打开分页、切换客户端或时间范围时调用：先汇总，再明细。
export async function openUsage() {
  renderBar();
  report('');
  try {
    const d = await actions.summary(view.client, view.range);
    renderSummary(d);
    if (!isEmpty(d)) await loadRequests();
  } catch (e) {
    report('读取用量失败：' + e.message);
  }
}

const filter = (key) => () => {
  view[key] = $('req-' + key).value;
  view.offset = 0;
  loadRequests().catch((e) => report('读取请求明细失败：' + e.message));
};
$('req-source').onchange = filter('source');
$('req-model').onchange = filter('model');
$('req-result').onchange = filter('result');
const page = (delta) => () => {
  view.offset = Math.max(0, view.offset + delta);
  loadRequests().catch((e) => report('读取请求明细失败：' + e.message));
};
$('req-prev').onclick = page(-PAGE);
$('req-next').onclick = page(PAGE);
$('usage-prices').onclick = () =>
  busy(
    $('usage-prices'),
    async () => {
      await actions.refreshPrices();
      await openUsage();
    },
    report,
  );
