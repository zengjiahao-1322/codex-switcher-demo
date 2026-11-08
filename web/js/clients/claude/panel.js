// Claude Code 页右侧详情：API 详情和“官方”详情两种。所有操作都经 busy()，失败原因显示在本页状态行。
import { $ } from '../../api.js';
import { modelCache } from '../../store.js';
import { busy, combo, merge } from '../../ui.js';
import { apply, enableAutostart, fetchModels, probe, restore } from './actions.js';
import { OFFICIAL, applyLabel, currentFact, host, originalFact, settingsPath } from './model.js';
import { claudeStatus } from './status.js';

const el = (tagName, className, text) => {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (text, onClick, className) => {
  const node = el('button', className, text);
  node.type = 'button';
  node.onclick = () => busy(node, onClick, claudeStatus);
  return node;
};
// 标签后跟一行小字说明用途。
const label = (text, note, forId) => {
  const node = el('label', '', text);
  node.htmlFor = forId;
  node.append(el('small', '', note));
  return node;
};

function officialPanel(panel, claudeCode, refresh) {
  panel.append(
    el('h3', '', 'Claude 官方登录'),
    el(
      'p',
      'context',
      '把切换器写进 settings.json 的 7 个变量恢复成接管前的样子，原来没有的就删掉。Claude 的登录凭据切换器从来不读也不改。',
    ),
  );
  const facts = el('dl', 'facts');
  for (const [name, value] of [
    ['当前', currentFact(claudeCode)],
    ['接管前', originalFact(claudeCode.original)],
    ['配置文件', settingsPath(claudeCode)],
  ])
    facts.append(el('dt', '', name), el('dd', '', value));
  const restoreButton = button(
    '恢复接管前的配置',
    async () => {
      const result = await restore();
      await refresh();
      claudeStatus(result.message);
    },
    'primary',
  );
  restoreButton.disabled = !claudeCode.original;
  const actions = el('div', 'actions');
  actions.append(restoreButton);
  panel.append(
    facts,
    actions,
    el(
      'p',
      'foot',
      claudeCode.original
        ? '如果接管前用的是别的网关，会恢复成那个网关，而不是官方。'
        : 'Claude Code 现在没有被切换器接管，不需要恢复。',
    ),
  );
}

function providerPanel(panel, item, claudeCode, port, refresh) {
  const where = host(item.baseUrl);
  panel.append(
    el('h3', '', item.label),
    el(
      'p',
      'context',
      'Claude Code 通过这个 API 使用所选模型。不会重启任何程序，新开的 Claude Code 会话生效（CLI、VS Code、桌面版 Code），已打开的会话需重开；Codex 不受影响。',
    ),
    item.access === 'adapter'
      ? el(
          'p',
          'hint info',
          '经本机转换：Claude Code → 本机切换器（127.0.0.1:' +
            port +
            '）→ ' +
            where +
            '。切换器要保持运行；回复是整段返回，不会逐字显示。',
        )
      : el('p', 'hint', '直连：Claude Code 直接访问 ' + where + '，不经过切换器。'),
  );
  if (item.access === 'adapter' && !claudeCode.autostart) {
    const warning = el('div', 'hint warn action');
    warning.append(
      el('span', '', '开机自启没开：重启电脑后要先打开切换器，Claude Code 才连得上。'),
      button('开启开机自启', async () => {
        const result = await enableAutostart();
        await refresh();
        claudeStatus(result.message);
      }),
    );
    panel.append(warning);
  }

  const options = () =>
    merge(
      merge(item.models || [], modelCache.get(item.id) || []),
      [item.model, item.fastModel].filter(Boolean),
    );
  const mainBox = el('div', 'combo'),
    main = el('input');
  main.id = 'claude-model';
  main.autocomplete = 'off';
  main.spellcheck = false;
  main.value = item.model || '';
  mainBox.append(main);
  const fetchButton = button('获取模型', async () => {
    claudeStatus('正在获取模型列表…');
    const result = await fetchModels(item.id);
    modelCache.set(item.id, result.models);
    claudeStatus(result.message + '点模型输入框即可选择，也可输入关键字筛选。');
    main.focus();
  });
  const mainRow = el('div', 'inline');
  mainRow.append(mainBox, fetchButton);
  const fastBox = el('div', 'combo'),
    fast = el('input');
  fast.id = 'claude-fast-model';
  fast.autocomplete = 'off';
  fast.spellcheck = false;
  fast.placeholder = '同主模型';
  fast.value = item.fastModel || '';
  fastBox.append(fast);
  panel.append(
    label('主模型', '日常对话和 Sonnet、Opus 别名', 'claude-model'),
    mainRow,
    label('快速模型', '后台小任务和 Haiku 别名，留空则同主模型', 'claude-fast-model'),
    fastBox,
  );
  combo(main, options);
  combo(fast, options);

  const useButton = button(
    applyLabel(item.id, claudeCode),
    async () => {
      const result = await apply(item.id, main.value.trim(), fast.value.trim());
      await refresh();
      claudeStatus(
        result.message +
          (result.needsAutostart ? '开机自启没开，重启电脑后要先打开切换器。' : ''),
      );
    },
    'primary',
  );
  const probeButton = button('检测连接', async () => {
    claudeStatus('正在检测连接…');
    const result = await probe(item.id, main.value.trim());
    claudeStatus(
      result.ok
        ? '检测通过：' + result.message + '（' + result.latencyMs + ' 毫秒）'
        : '检测未通过：' + result.message,
    );
  });
  const actions = el('div', 'actions');
  actions.append(useButton, probeButton);
  panel.append(
    actions,
    el(
      'p',
      'foot',
      '检测会按 Claude Code 实际走的路径发一条最短的请求。改了这个 API 的地址或密钥时，如果 Claude Code 正在用它，会自动同步过去。',
    ),
  );
}

export function renderClaudePanel(item, claudeCode, port, refresh) {
  const panel = $('claude-panel');
  panel.replaceChildren();
  if (item.id === OFFICIAL) officialPanel(panel, claudeCode, refresh);
  else providerPanel(panel, item, claudeCode, port, refresh);
}
