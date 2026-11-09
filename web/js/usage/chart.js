import { el } from '../ui.js';
import { axisLabel, axisTop, tokens } from './model.js';

// 堆叠柱状图：每根柱子从下到上依次是未缓存输入、缓存读、缓存写、输出。
const parts = [
  ['input', '未缓存输入'],
  ['cachedInput', '缓存读'],
  ['cacheWrite', '缓存写'],
  ['output', '输出'],
];

// Codex 没有缓存写时，图例里也不显示这一项。
export function renderLegend(container, series) {
  const shown = parts.filter(([key]) => key !== 'cacheWrite' || series.some((s) => s.cacheWrite));
  container.replaceChildren(
    ...shown.map(([key, label]) => {
      const item = el('span', null, label);
      item.prepend(el('i', 'usage-swatch ' + key));
      return item;
    }),
  );
}

export function renderChart(container, series, range) {
  const top = axisTop(series);
  const grid = [1, 0.5, 0].map((f) => {
    const line = el('div', 'usage-grid');
    line.style.bottom = f * 100 + '%';
    line.append(el('span', null, tokens(Math.round(top * f))));
    return line;
  });
  const bars = series.map((point, index) => {
    const bar = el('div', 'usage-bar-col');
    const label = axisLabel(point.at, index, range) || new Date(point.at).toLocaleString('zh-CN');
    bar.title =
      label + '\n' + parts.map(([key, name]) => `${name} ${tokens(point[key])}`).join('\n');
    for (const [key] of parts) {
      const piece = el('i', 'usage-piece ' + key);
      piece.style.height = (point[key] / top) * 100 + '%';
      bar.append(piece);
    }
    return bar;
  });
  const plot = el('div', 'usage-plot');
  plot.append(...grid);
  const columns = el('div', 'usage-bars');
  columns.append(...bars);
  plot.append(columns);
  const axis = el('div', 'usage-axis');
  axis.append(...series.map((point, index) => el('span', null, axisLabel(point.at, index, range))));
  container.replaceChildren(plot, axis);
}
