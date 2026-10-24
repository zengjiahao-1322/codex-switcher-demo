import { $, api } from '../api.js';
import { refresh } from '../main.js';
import { accountData, modelCache, state } from '../store.js';
import { activeTab, showTab } from '../tabs.js';
import { busy, rowButton, status, tag } from '../ui.js';
import { beginLogin, refreshAccounts } from './accounts.js';
import { renderRemotes } from './remotes.js';
import { chooseSource } from './sources.js';

export function renderDiagnosis() {
  if (activeTab === 'editors' && $('diagnosis-details').open) runDiagnosis();
}
export let lastClients = '';
export async function refreshClients() {
  if (!lastClients) $('clients-status').textContent = '正在查看运行中的 Codex…';
  try {
    const c = await api('clients', {});
    renderRemotes(c.remotes, c.connectedEditors);
    // 自动重载的前提直接显示在勾选框旁，避免用户把“勾选”当成“已连接”。
    const missing = c.clients.filter(
      (p) => p.kind === 'ide' && p.confirmed && p.shared && !p.editorId,
    );
    const ready = c.clients.filter((p) => p.kind === 'editor' && p.canReload);
    const separate = c.clients.filter((p) => p.kind === 'editor' && p.confirmed && !p.shared);
    const unmatched = c.clients.filter((p) => p.kind === 'editor' && !p.confirmed);
    const outdated = c.clients.filter((p) => p.kind === 'editor' && p.reloadProtocol < 2);
    // 分别展示可重载、独立配置和未关联的窗口，不从“没有找到”推断远端归属。
    const parts = [];
    const pids = (rows) => 'PID ' + rows.map((p) => p.pid).join('、');
    if (ready.length)
      parts.push(ready.length + ' 个窗口已接入（扩展宿主 ' + pids(ready) + '），可自动重载');
    if (missing.length)
      parts.push(
        missing.length +
          ' 个共用配置的 Codex 后台（' +
          pids(missing) +
          '）没有对应到已接入的窗口，暂不能自动切换',
      );
    if (separate.length) parts.push(separate.length + ' 个窗口使用独立配置目录，不随本机切换');
    if (unmatched.length)
      parts.push(
        unmatched.length + ' 个窗口尚未关联到本机可见的 Codex 后端，暂不能确认是否跟随本机切换',
      );
    if (outdated.length)
      parts.push(outdated.length + ' 个窗口使用旧版伴随扩展，请重新安装本版 VSIX 并重载窗口');
    $('editor-reload-hint').textContent = parts.length
      ? parts.join('；') + '。'
      : '尚无已确认共用配置、可自动重载的编辑器窗口。';
    // 状态卡只给结论，进程编号等细节留在“编辑器与诊断”。
    $('editor-summary').textContent =
      (ready.length
        ? ready.length + ' 个编辑器窗口会随切换自动重载'
        : '没有会随切换自动重载的编辑器窗口') +
      (missing.length || unmatched.length || outdated.length ? '，有窗口需要处理。' : '。');
    $('clients-status').textContent =
      `本次切换目录：${c.home}\nCodex 程序：${c.runtime || '未找到，请安装官方扩展或填写下方路径'}\n检测到 ${c.clients.length} 个客户端 / 窗口，${c.connectedEditors} 个伴随扩展连接。`;
    if (document.activeElement !== $('config-home')) $('config-home').value = c.home;
    $('config-homes').replaceChildren();
    for (const home of new Set(c.clients.map((p) => p.home).filter(Boolean))) {
      const option = document.createElement('option');
      option.value = home;
      $('config-homes').append(option);
    }
    const key = JSON.stringify([c.clients, c.auxiliary, c.editors]);
    if (key === lastClients) return;
    lastClients = key;
    $('clients-list').replaceChildren();
    for (const client of c.clients) {
      const row = document.createElement('div');
      row.className = 'client-row';
      const title = document.createElement('b');
      title.textContent = client.name + ' · PID ' + client.pid;
      // 归属以实际后端的配置目录为准；远程 / WSL 只是窗口类型，不决定是否跟随切换。
      row.append(
        title,
        tag(
          client.confirmed ? (client.shared ? '共用当前目录' : '独立目录') : '归属未确认',
          client.shared ? 'done' : 'muted',
        ),
      );
      if (client.remote || client.wsl)
        row.append(tag(client.wsl ? 'WSL 窗口' : '远程窗口', 'muted'));
      const detail = document.createElement('small');
      detail.textContent =
        (client.home || '尚未确认 CODEX_HOME') +
        (client.homeSource
          ? ' · ' + (client.homeSource === 'default' ? '进程默认目录' : '进程 CODEX_HOME')
          : '') +
        (client.error ? '\n进程读取失败：' + client.error : '') +
        (client.workspace ? '\n' + client.workspace : '') +
        (client.kind === 'editor' && !client.confirmed
          ? '\n尚未关联到本机可见的 Codex 后端，暂不能确认是否跟随本机切换。可导出诊断日志查看进程关系。'
          : '') +
        (client.kind === 'editor'
          ? '\n客户端：' +
            (client.editorKind || client.name) +
            ' · Codex 扩展：' +
            (client.extensionName || client.extensionId || '未识别') +
            ' · 伴随扩展：' +
            (client.companionVersion || '版本未知，可重新接入以更新')
          : '') +
        (client.kind === 'editor' && client.reloadProtocol < 2
          ? '\n当前伴随扩展较旧（仍可能显示“已连接”），请重新安装本版 VSIX 并重载窗口。'
          : '') +
        (client.commandPending ? '\n重载请求等待窗口接收；请查看编辑器状态栏是否已连接。' : '') +
        (client.lastAck?.status === 'reload_requested'
          ? '\n窗口已接收重载请求；若仍显示旧进程，请检查编辑器是否有待处理的保存或任务提示。'
          : '') +
        (client.lastAck?.status === 'reloaded'
          ? '\n伴随扩展已重载并重新连接；尚未验证实际模型请求。'
          : '') +
        (client.lastAck?.status === 'reload_failed' ? '\n重载失败：' + client.lastAck.error : '') +
        (client.stale ? '\n启动早于最近切换，可能需重载。' : '') +
        (client.overridden ? '\n配置档 / 启动参数覆盖了全局模型或供应商，请展开核对。' : '');
      row.append(detail);
      if (client.layers?.length > 1) {
        const layers = document.createElement('details'),
          summary = document.createElement('summary');
        summary.textContent = '配置层与启动覆盖';
        layers.append(summary);
        for (const l of client.layers) {
          const line = document.createElement('small');
          line.textContent =
            l.source + '：' + (l.file || '') + ' ' + (l.error || JSON.stringify(l.values));
          layers.append(line);
        }
        row.append(layers);
      }
      if (client.canReload)
        row.append(
          rowButton(
            client.commandPending ? '重载请求已发送' : '重载此窗口',
            async () => {
              const r = await api('reloadClients', { id: client.editorId });
              status(r.message);
              await refreshClients();
            },
            status,
          ),
        );
      else if (client.kind === 'ide' && !client.editorId) {
        const note = document.createElement('small');
        note.textContent = '这个 Codex 后台没有对应到已接入伴随扩展的窗口，暂不能自动重载。';
        row.append(note);
      }
      $('clients-list').append(row);
    }
    if (c.auxiliary?.length) {
      const extra = document.createElement('details'),
        summary = document.createElement('summary');
      summary.textContent = `辅助后台 ${c.auxiliary.length} 个（不计入客户端数量）`;
      extra.append(summary);
      for (const p of c.auxiliary) {
        const line = document.createElement('p');
        line.className = 'note';
        line.textContent = `${p.name} · PID ${p.pid}\n${p.home || '配置目录未确认'}${p.shared ? ' · 共用当前目录' : ''}。由自动化工具启动，不代表另一个桌面窗口。`;
        extra.append(line);
      }
      $('clients-list').append(extra);
    }
    $('companion-install').replaceChildren();
    for (const editor of c.editors || [])
      $('companion-install').append(
        rowButton(
          '接入 ' + editor.name,
          async () => {
            status('正在安装伴随扩展…');
            const r = await api('companionInstall', { id: editor.id });
            status(r.message);
            await refreshClients();
          },
          status,
        ),
      );
  } catch (e) {
    $('clients-status').textContent = e.message;
    $('editor-reload-hint').textContent = '无法确认编辑器连接：' + e.message;
    $('editor-summary').textContent = '无法确认编辑器连接。';
  }
}
$('editor-connection').onclick = (e) => {
  e.preventDefault();
  showTab('editors');
  $('tab-editors').scrollIntoView({ behavior: 'smooth', block: 'start' });
};
$('clients-refresh').onclick = refreshClients;
$('environment-save').onclick = () =>
  busy($('environment-save'), async () => {
    const input = { home: $('config-home').value, codexExe: $('runtime-path').value };
    let r;
    try {
      r = await api('setEnvironment', input);
    } catch (e) {
      if (e.code !== 'untrusted_codex') throw e;
      // 切换器会以当前用户身份运行这个程序，只在用户确认来源后才保存。
      if (
        !confirm(
          '这个程序不在 Codex 官方安装目录或官方编辑器扩展目录中：\n' +
            input.codexExe.trim() +
            '\n\n登录、读取额度和同步旧对话时，切换器都会运行它。只有确认它来自 OpenAI 时才继续。',
        )
      ) {
        status('未保存：程序路径未确认。');
        return;
      }
      r = await api('setEnvironment', { ...input, allowUntrusted: true });
    }
    lastClients = null;
    modelCache.clear();
    await refreshAccounts();
    await refresh();
    await refreshClients();
    status(r.message);
  });
// 诊断日志由后台脱敏后返回文本，在页面里直接存成文件，不经过下载链接。
$('diagnostics-export').onclick = () =>
  busy($('diagnostics-export'), async () => {
    const r = await api('exportDiagnostics', {}),
      link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([r.text], { type: 'text/plain;charset=utf-8' }));
    link.download = r.filename;
    link.click();
    URL.revokeObjectURL(link.href);
    status('已生成 ' + r.filename + '。内容已脱敏，不含登录令牌和 API 密钥，可以直接发给维护者。');
  });
$('companion-download').onclick = () =>
  busy($('companion-download'), async () => {
    const r = await api('companionPackage', {}),
      a = document.createElement('a');
    a.href = r.url;
    a.download = r.filename;
    a.textContent = '下载 ' + r.filename;
    a.style.color = 'var(--accent)';
    $('companion-install').replaceChildren(a);
    status('安装包已生成，点击旁边的下载链接。下载后在 VS Code 扩展菜单选择“从 VSIX 安装”。');
  });
export let diagnosisSeq = 0,
  threadsSeq = 0;
export async function refreshThreads() {
  const seq = ++threadsSeq,
    r = await api('threads', { query: $('thread-query').value });
  if (seq !== threadsSeq) return;
  const keep = $('diagnosis-thread').value;
  $('diagnosis-thread').replaceChildren(new Option('当前配置', ''));
  for (const t of r.items) {
    const title = (t.title || t.id).replace(/\s+/g, ' ');
    $('diagnosis-thread').append(
      new Option(
        (t.archived ? '[已归档] ' : '') +
          title.slice(0, 100) +
          (title.length > 100 ? '…' : '') +
          ' · ' +
          t.model_provider,
        t.id,
      ),
    );
  }
  if ([...$('diagnosis-thread').options].some((o) => o.value === keep))
    $('diagnosis-thread').value = keep;
  if (r.error) $('diagnosis-status').textContent = r.error;
}
export async function diagnosisAction(action) {
  if (action.type === 'accounts') {
    showTab('accounts');
    $('tab-accounts').scrollIntoView({ behavior: 'smooth' });
    return;
  }
  if (action.type === 'reauth') return beginLogin(action.id);
  if (['official', 'account'].includes(action.type)) {
    const a =
      accountData.items.find((a) => a.id === action.id) ||
      accountData.items.find((a) => a.current) ||
      accountData.items[0];
    chooseSource(a ? 'account:' + a.id : 'official');
    status('已选中官方账号，请点“切换到这里”。');
    return;
  }
  if (action.type === 'api') {
    const p =
      state.providers.find((p) => p.id !== 'official' && p.inUse) ||
      state.providers.find((p) => p.id !== 'official');
    if (p) chooseSource(p.id, action.model);
    status('请选择原 API；历史的共享供应商标记无法证明是哪家 API。');
    return;
  }
  if (action.type === 'reapply') {
    const a = accountData.items.find((a) => a.current),
      p = state.providers.find((p) => p.inUse);
    chooseSource(state.current.official ? (a ? 'account:' + a.id : 'official') : p.id);
    $('switch').click();
    return;
  }
  if (action.type === 'probe') {
    const p = state.providers.find((p) => p.id !== 'official' && p.inUse);
    if (!p) throw Error('当前未找到正在使用的 API 配置');
    const r = await api('probe', { id: p.id, model: state.current.model });
    const line = document.createElement('p');
    line.textContent = '实时检测：' + r.message;
    $('diagnosis-status').append(line);
    return;
  }
  if (action.type === 'export') {
    const r = await api('exportContext', { id: action.id }),
      line = document.createElement('p');
    line.textContent = r.message + '\n' + r.file;
    $('diagnosis-status').append(line);
    $('diagnosis-actions').append(
      rowButton(
        '复制新会话提示',
        async () => {
          await navigator.clipboard.writeText(
            '请读取此历史对话上下文文件，先概括已有进展，再继续我的任务：' + r.file,
          );
          status('已复制。新建 Codex 会话后粘贴即可。');
        },
        status,
      ),
    );
    return;
  }
}
export async function runDiagnosis() {
  const seq = ++diagnosisSeq,
    id = $('diagnosis-thread').value;
  $('diagnosis-status').textContent = '正在检查配置、会话与关联日志…';
  $('diagnosis-actions').replaceChildren();
  try {
    const r = await api('diagnose', id ? { id } : {});
    if (seq !== diagnosisSeq) return;
    $('diagnosis-status').replaceChildren();
    if (r.thread) {
      const heading = document.createElement('p');
      heading.textContent =
        '会话：' +
        r.thread.title +
        '\n供应商：' +
        r.thread.provider +
        ' · 模型：' +
        (r.thread.model || '未知');
      $('diagnosis-status').append(heading);
    }
    for (const f of r.findings) {
      const item = document.createElement('div');
      item.className = 'finding ' + f.level;
      const title = document.createElement('b');
      title.textContent = f.title;
      const text = document.createElement('p');
      text.textContent = f.detail;
      item.append(title, text);
      $('diagnosis-status').append(item);
    }
    for (const a of r.actions)
      $('diagnosis-actions').append(rowButton(a.label, () => diagnosisAction(a), status));
  } catch (e) {
    if (seq === diagnosisSeq) $('diagnosis-status').textContent = e.message;
  }
}
$('diagnosis-details').ontoggle = async () => {
  if ($('diagnosis-details').open)
    try {
      await refreshThreads();
      await runDiagnosis();
    } catch (e) {
      $('diagnosis-status').textContent = e.message;
    }
};
$('threads-refresh').onclick = () =>
  busy($('threads-refresh'), async () => {
    await refreshThreads();
    await runDiagnosis();
  });
$('diagnosis-thread').onchange = runDiagnosis;
$('diagnosis-run').onclick = runDiagnosis;
