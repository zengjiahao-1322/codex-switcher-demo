import { $, api } from '../api.js';
import { accountData, modelCache, state } from '../store.js';
import { busy, merge, tag } from '../ui.js';
import { accountFacts, quotaNode } from './accounts.js';
import { sourceCard } from './sources.js';

// 远程服务器：Remote-SSH 窗口里的 Codex 读写服务器自己的 CODEX_HOME，和本机切换互不跟随。
// 账号和 API 与本机共用同一份列表；每台服务器一张切换卡，单独应用。
// 列表按 (authority, codexHome) 分组返回；这里按服务器（authority）合并，一次应用到它的全部配置目录。
export let remotes = [];
// drafts：每台服务器选中的来源和模型；results：应用结果；installs：只在显示安装按钮时展示，代理接入后自然消失。
const drafts = new Map(),
  results = new Map(),
  installs = new Map();
let rendered = '',
  connected = 0,
  server = null;
const hostOf = (url) => url.replace(/^https?:\/\//, '').split('/')[0];
const sameUrl = (x, y) => x.replace(/\/+$/, '') === y.replace(/\/+$/, '');
// 协议号 2 起带官方登录读写；同版本号重新发布时，旧代理只能靠协议号认出。
const agentState = (rows) =>
  rows.some((r) => !r.agentVersion)
    ? ['未安装远端代理', 'changed']
    : rows.some(
          (r) =>
            r.agentProtocol !== 2 || r.windows.some((w) => w.agentVersion !== w.companionVersion),
        )
      ? ['远端代理需更新', 'changed']
      : ['已接入', 'done'];
// 服务器连不到本机的转换服务，所以只有可直连且有密钥的 API 能用；官方账号的登录会写到服务器上。
const blockedReason = (p) =>
  p.access?.mode === 'adapter'
    ? '需要本机转换，服务器用不了'
    : !p.hasKey
      ? '缺少密钥，先在“API 配置”里填写'
      : p.access?.mode !== 'direct'
        ? '还没检测为直连，先在“API 配置”里检测'
        : '';
const official = (r) => !r.current?.modelProvider || r.current.modelProvider === 'openai';
const usingAccount = (rows, a) => rows.some((r) => official(r) && r.account?.id === a.id);
const usingApi = (rows, p) =>
  rows.some((r) => !official(r) && r.current.baseUrl && sameUrl(r.current.baseUrl, p.baseUrl));
const currentText = (r) =>
  !r.agentVersion
    ? ''
    : !r.current
      ? '还没有配置文件'
      : '当前 ' +
        (official(r)
          ? r.account
            ? '官方 · ' + r.account.email + ' · ' + r.account.plan
            : '服务器自己的登录'
          : r.current.baseUrl
            ? hostOf(r.current.baseUrl)
            : r.current.modelProvider) +
        (r.current.model ? ' · ' + r.current.model : '');
const resultLabels = { synced: '已写入，已请求重载窗口', skipped: '未切换', failed: '失败' };

export function renderRemotes(list, editors = connected) {
  remotes = list;
  connected = editors;
  const servers = new Map();
  for (const r of list) servers.set(r.authority, [...(servers.get(r.authority) || []), r]);
  $('remote-count').textContent = servers.size || '';
  // 首屏请求并发，API 列表可能还没到；内容等打开分页刷新时再画。
  if (!state) return;
  if (!servers.has(server)) server = servers.keys().next().value ?? null;
  // 每 5 秒刷新一次；内容不变时不重绘，避免打断正在选择的来源和模型。
  const key = JSON.stringify([
    list,
    connected,
    server,
    state.providers,
    accountData?.items,
    [...drafts],
    [...results],
    [...installs],
  ]);
  if (key === rendered) return;
  rendered = key;
  $('remote-list').replaceChildren();
  if (!servers.size) return $('remote-list').append(emptyGuide());
  // 多台服务器时顶部用标签切换，每次只显示一台的切换卡。
  if (servers.size > 1) {
    const tabs = document.createElement('div');
    tabs.className = 'seg remote-servers';
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', '选择服务器');
    for (const [authority, rows] of servers) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = hostName(authority, rows);
      b.setAttribute('aria-pressed', String(authority === server));
      b.onclick = () => {
        server = authority;
        renderRemotes(remotes);
      };
      tabs.append(b);
    }
    $('remote-list').append(tabs);
  }
  $('remote-list').append(serverCard(server, servers.get(server)));
}

const hostName = (authority, rows) => rows[0].host || authority.replace(/^ssh-remote\+/, '');

// 没有 SSH 窗口时说明怎么接入，并给出本机伴随扩展的连接情况，方便看出卡在哪一步。
function emptyGuide() {
  const guide = document.createElement('p');
  guide.className = 'note pre';
  guide.textContent =
    '还没有检测到 Remote-SSH 窗口。\n' +
    (connected
      ? '本机已有 ' + connected + ' 个编辑器窗口接入伴随扩展。'
      : '本机还没有编辑器接入伴随扩展：先在“编辑器与诊断”里点“接入 VS Code”。') +
    '\n\n接入步骤：\n1. 本机 VS Code 安装伴随扩展（“编辑器与诊断”→“接入 VS Code”）。\n2. 在 VS Code 里用 Remote-SSH 连上服务器，几秒后服务器会出现在这里。\n3. 按提示安装远端代理，再选择账号或 API，应用到这台服务器。';
  return guide;
}

function serverCard(authority, rows) {
  const card = document.createElement('div'),
    head = document.createElement('div'),
    name = document.createElement('b'),
    host = hostName(authority, rows);
  card.className = 'remote-card';
  name.textContent = host;
  const [text, cls] = agentState(rows);
  head.append(name, tag(text, cls));
  if (rows[0].platform) head.append(tag(rows[0].platform));
  card.append(head);
  for (const r of rows) {
    const line = document.createElement('small');
    line.textContent = r.codexHome + (currentText(r) ? ' · ' + currentText(r) : '');
    card.append(line);
  }
  if (cls === 'changed') {
    // 在这台服务器的窗口里安装本版远端代理；workspace 扩展会装到服务器一侧。
    const install = document.createElement('button');
    install.type = 'button';
    install.textContent = rows.some((r) => r.agentVersion) ? '更新远端代理' : '安装远端代理';
    install.onclick = () =>
      busy(
        install,
        async () => {
          installs.set(authority, '正在服务器上安装远端代理…');
          renderRemotes(remotes);
          await api('installRemoteAgent', { id: rows[0].windows[0].id });
          installs.set(authority, '已安装。若仍显示未安装，请在该窗口里按提示重载。');
          renderRemotes(remotes);
        },
        (message) => {
          installs.set(authority, message);
          renderRemotes(remotes);
        },
      );
    card.append(install);
    if (installs.has(authority)) card.append(note(installs.get(authority)));
  } else card.append(chooser(authority, host, rows));
  return card;
}

function note(text) {
  const p = document.createElement('p');
  p.className = 'note pre';
  p.textContent = text;
  return p;
}

// 切换卡：左边是和主界面同样的来源列表，右边是选中来源的说明、模型和应用按钮。
function chooser(authority, host, rows) {
  const items = accountData?.items || [],
    apis = state.providers.filter((p) => p.id !== 'official');
  const options = [
    ...items.map((a) => ({ value: 'account:' + a.id, name: a.label, account: a })),
    ...apis.map((p) => ({ value: p.id, name: p.name, provider: p })),
  ];
  const inUse = (o) => (o.account ? usingAccount(rows, o.account) : usingApi(rows, o.provider));
  const draft = drafts.get(authority) || {};
  const picked =
    options.find((o) => o.value === draft.source) ||
    options.find((o) => inUse(o) && !(o.provider && blockedReason(o.provider))) ||
    options.find((o) => !(o.provider && blockedReason(o.provider)));
  const wrap = document.createElement('div'),
    list = document.createElement('div'),
    panel = document.createElement('div');
  wrap.className = 'remote-chooser';
  list.className = 'remote-sources';
  list.setAttribute('role', 'radiogroup');
  list.setAttribute('aria-label', host + ' 使用的账号或 API');
  panel.className = 'remote-detail';
  let group = '';
  for (const o of options) {
    const kind = o.account ? 'account' : 'api';
    if (kind !== group) {
      group = kind;
      const label = document.createElement('div');
      label.className = 'group-label';
      label.textContent = kind === 'account' ? '官方账号' : '自定义 API';
      list.append(label);
    }
    list.append(
      sourceCard(o, {
        checked: o === picked,
        using: inUse(o) ? tag('服务器正在使用', 'done') : null,
        model: o.provider?.model,
        blocked: o.provider ? blockedReason(o.provider) : '',
        onPick: () => {
          drafts.set(authority, { source: o.value, model: o.provider?.model || '' });
          renderRemotes(remotes);
        },
      }),
    );
  }
  if (!options.length) {
    const empty = document.createElement('p');
    empty.className = 'group-label';
    empty.textContent = '还没有保存的官方账号或自定义 API。';
    list.append(empty);
  }
  wrap.append(list, panel);
  if (picked) detail(panel, authority, host, rows, picked, draft);
  else panel.append(note('没有能用于服务器的账号或 API。'));
  if (results.has(authority)) panel.append(note(results.get(authority)));
  return wrap;
}

function detail(panel, authority, host, rows, o, draft) {
  const title = document.createElement('h3'),
    context = document.createElement('p'),
    buttons = document.createElement('div'),
    apply = document.createElement('button'),
    dirs = rows.map((r) => r.codexHome),
    a = o.account,
    p = o.provider;
  title.textContent = o.name;
  context.className = 'context';
  context.textContent =
    (a
      ? '服务器使用 ChatGPT 官方服务和这个账号。登录会保存到服务器上（只有当前用户可读）；本机和服务器同时用这个账号时，切换器会让两边的登录保持一致。'
      : '服务器直接访问这个 API，地址、模型和密钥写入服务器的 config.toml（只有当前用户可读）。') +
    '应用后这台服务器的窗口会重载，本机不受影响。';
  panel.append(title, context);
  let model = null;
  if (a) panel.append(accountFacts(a), quotaNode(a.quota));
  else {
    const label = document.createElement('label'),
      models = document.createElement('datalist');
    model = document.createElement('input');
    label.textContent = '模型';
    models.id = 'remote-models-' + authority.replace(/\W/g, '-');
    for (const m of merge(p.models || [], modelCache.get(p.id) || [])) {
      const option = document.createElement('option');
      option.value = m;
      models.append(option);
    }
    model.setAttribute('list', models.id);
    model.setAttribute('aria-label', '服务器使用的模型');
    model.spellcheck = false;
    model.autocomplete = 'off';
    model.value = draft.source === o.value ? draft.model : p.model;
    model.oninput = () => drafts.set(authority, { source: o.value, model: model.value });
    label.append(model);
    panel.append(label, models);
  }
  const hint = document.createElement('small');
  hint.className = 'hint';
  hint.textContent = '在官方账号和 API 之间切换后，服务器上另一边创建的旧对话可能不显示。';
  apply.type = 'button';
  apply.className = 'primary';
  apply.textContent = '应用到这台服务器';
  apply.onclick = () =>
    busy(
      apply,
      async () => {
        const chosen = model?.value.trim();
        if (p && !chosen) throw Error('请填写模型。');
        const where = dirs.join('、');
        if (
          !confirm(
            a
              ? '把服务器 ' +
                  host +
                  ' 的 Codex 切换到官方账号「' +
                  a.email +
                  '」。\n\n这个账号的登录会保存到服务器 ' +
                  where +
                  ' 中的 auth.json（只有当前用户可读），config.toml 改为官方登录，并重载这台服务器的窗口，窗口里正在运行的 Codex 任务会中断。本机和服务器同时用这个账号时，切换器会让两边的登录保持一致。本机不受影响。继续？'
              : '把服务器 ' +
                  host +
                  ' 的 Codex 切换到「' +
                  p.name +
                  '」· ' +
                  chosen +
                  '。\n\nAPI 地址、模型和密钥会写入这台服务器 ' +
                  where +
                  ' 中的 config.toml（只有当前用户可读），并重载这台服务器的窗口，窗口里正在运行的 Codex 任务会中断。本机不受影响。继续？',
          )
        )
          return;
        results.set(authority, '正在应用到服务器…');
        renderRemotes(remotes);
        const r = await api(
          'remoteSwitch',
          a ? { authority, accountId: a.id } : { authority, providerId: p.id, model: chosen },
        );
        results.set(
          authority,
          r.results
            .map(
              (x) =>
                x.codexHome + '：' + resultLabels[x.status] + (x.reason ? ' · ' + x.reason : ''),
            )
            .join('\n'),
        );
        renderRemotes(remotes);
      },
      (message) => {
        results.set(authority, message);
        renderRemotes(remotes);
      },
    );
  buttons.className = 'actions';
  buttons.append(apply);
  panel.append(hint, buttons);
}
