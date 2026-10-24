import { $, api } from '../api.js';
import { state } from '../store.js';
import { rowButton, tag } from '../ui.js';

// 远程服务器：Remote-SSH 窗口里的 Codex 读写服务器自己的 CODEX_HOME，和本机切换互不影响。
// 列表按 (authority, codexHome) 分组返回；这里按服务器（authority）合并成一张卡片，一次应用到它的全部配置目录。
export let remotes = [];
const drafts = new Map(),
  results = new Map();
let rendered = '';
const hostOf = (url) => url.replace(/^https?:\/\//, '').split('/')[0];
const agentState = (rows) =>
  rows.some((r) => !r.agentVersion)
    ? ['未安装远端代理', 'changed']
    : rows.some((r) => r.windows.some((w) => w.agentVersion !== w.companionVersion))
      ? ['远端代理需更新', 'changed']
      : ['已接入', 'done'];
// 服务器连不到本机的转换服务，官方登录也不能和本机共用，所以只给可直连且有密钥的 API。
const usable = () =>
  state.providers.filter((p) => p.id !== 'official' && p.access?.mode === 'direct' && p.hasKey);
const currentText = (r) =>
  !r.agentVersion
    ? ''
    : !r.current
      ? '还没有配置文件'
      : '当前 ' +
        (r.current.modelProvider === 'openai'
          ? '官方账号'
          : r.current.baseUrl
            ? hostOf(r.current.baseUrl)
            : r.current.modelProvider || 'Codex 默认') +
        (r.current.model ? ' · ' + r.current.model : '');
const resultLabels = { synced: '已写入，已请求重载窗口', skipped: '未切换', failed: '失败' };

export function renderRemotes(list) {
  remotes = list;
  const servers = new Map();
  for (const r of list) servers.set(r.authority, [...(servers.get(r.authority) || []), r]);
  $('tab-remotes').hidden = !servers.size;
  $('remote-count').textContent = servers.size || '';
  // 首屏请求并发，API 列表可能还没到；内容等打开分页刷新时再画。
  if (!state) return;
  // 每 5 秒刷新一次；内容不变时不重绘，避免打断正在选择的 API 和模型。
  const key = JSON.stringify([list, usable(), [...drafts], [...results]]);
  if (key === rendered) return;
  rendered = key;
  $('remote-list').replaceChildren();
  for (const [authority, rows] of servers) $('remote-list').append(serverCard(authority, rows));
}

function serverCard(authority, rows) {
  const card = document.createElement('div'),
    head = document.createElement('div'),
    name = document.createElement('b'),
    host = rows[0].host || authority.replace(/^ssh-remote\+/, '');
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
    const installTarget = rows[0].windows[0];
    card.append(
      rowButton(
        rows.some((r) => r.agentVersion) ? '更新远端代理' : '安装远端代理',
        async () => {
          results.set(authority, '正在服务器上安装远端代理…');
          renderRemotes(remotes);
          await api('installRemoteAgent', { id: installTarget.id });
          results.set(authority, '已安装。若仍显示未安装，请在该窗口里按提示重载。');
          renderRemotes(remotes);
        },
        (message) => {
          results.set(authority, message);
          renderRemotes(remotes);
        },
      ),
    );
  } else card.append(applyForm(authority, host, rows));
  if (results.has(authority)) {
    const result = document.createElement('p');
    result.className = 'note pre';
    result.textContent = results.get(authority);
    card.append(result);
  }
  return card;
}

function applyForm(authority, host, rows) {
  const form = document.createElement('div'),
    providers = usable();
  form.className = 'remote-form';
  if (!providers.length) {
    const none = document.createElement('small');
    none.textContent =
      '没有可用于服务器的 API：需要是检测为“直连”且填了密钥的自定义 API，可在“API 配置”里检测。';
    form.append(none);
    return form;
  }
  const draft = drafts.get(authority) || {
    providerId: providers[0].id,
    model: providers[0].model,
  };
  const provider = providers.find((p) => p.id === draft.providerId) || providers[0];
  const select = document.createElement('select'),
    model = document.createElement('input'),
    models = document.createElement('datalist');
  const option = (value, text = value) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    return o;
  };
  select.setAttribute('aria-label', '服务器使用的 API');
  for (const p of providers) select.append(option(p.id, p.name));
  select.value = provider.id;
  models.id = 'remote-models-' + authority.replace(/\W/g, '-');
  for (const m of provider.models || []) models.append(option(m));
  model.setAttribute('list', models.id);
  model.setAttribute('aria-label', '服务器使用的模型');
  model.spellcheck = false;
  model.value = draft.model;
  select.onchange = () => {
    const next = providers.find((p) => p.id === select.value);
    drafts.set(authority, { providerId: next.id, model: next.model });
    renderRemotes(remotes);
  };
  model.oninput = () => drafts.set(authority, { providerId: provider.id, model: model.value });
  const dirs = rows.map((r) => r.codexHome);
  const apply = rowButton(
    '应用到这台服务器',
    async () => {
      const chosen = model.value.trim();
      if (!chosen) throw Error('请填写模型。');
      if (
        !confirm(
          '把服务器 ' +
            host +
            ' 的 Codex 切换到「' +
            provider.name +
            '」· ' +
            chosen +
            '。\n\nAPI 地址、模型和密钥会写入这台服务器 ' +
            dirs.join('、') +
            ' 中的 config.toml（只有当前用户可读），并重载这台服务器的窗口，窗口里正在运行的 Codex 任务会中断。本机不受影响。继续？',
        )
      )
        return;
      results.set(authority, '正在应用到服务器…');
      renderRemotes(remotes);
      const r = await api('remoteSwitch', { authority, providerId: provider.id, model: chosen });
      results.set(
        authority,
        r.results
          .map(
            (x) => x.codexHome + '：' + resultLabels[x.status] + (x.reason ? ' · ' + x.reason : ''),
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
  apply.className = 'primary';
  form.append(select, model, models, apply);
  return form;
}
