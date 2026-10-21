'use strict';
const { PROJECT_ROOT } = require('../paths.cjs');

const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { powershell } = require('./desktop-account.cjs');
const { writeJson, readJson } = require('../accounts/accounts.cjs');
const canonical = (p) => {
  let value = path.resolve(p);
  try {
    value = fs.realpathSync.native(value);
  } catch {}
  value = value.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? value.toLowerCase() : value;
};
const sameHome = (a, b) => !!a && !!b && canonical(a) === canonical(b);
const isDesktop = (p) => require('../platform/platform.cjs').isCodexDesktop(p.exe || '');
let cached;
function scan({ force = false } = {}) {
  if (!force && cached && Date.now() - cached.at < 2500) return cached.value;
  const value =
    process.platform === 'darwin'
      ? require('../platform/mac-processes.cjs').scan()
      : JSON.parse(
          powershell(
            fs.readFileSync(
              path.join(PROJECT_ROOT, 'platform/windows/process-context.ps1'),
              'utf8',
            ),
          ),
        );
  cached = { at: Date.now(), value };
  return value;
}
function ancestryOf(p, all) {
  const found = [],
    seen = new Set();
  let id = p.parentPid;
  while (id && !seen.has(id)) {
    seen.add(id);
    const parent = all.find((x) => x.pid === id);
    if (!parent) break;
    found.push(parent);
    id = parent.parentPid;
  }
  return found;
}
function configLayers(home, cwd, profile, overrides = {}) {
  const layers = [];
  const add = (file, source) => {
    if (!fs.existsSync(file) || layers.some((l) => sameHome(l.file, file))) return;
    try {
      const c = require('smol-toml').parse(fs.readFileSync(file, 'utf8'));
      const values = {};
      for (const k of ['model', 'model_provider', 'model_catalog_json'])
        if (c[k] !== undefined) values[k] = c[k];
      layers.push({ file, source, values });
    } catch {
      layers.push({ file, source, error: '配置无法解析' });
    }
  };
  if (home) {
    const file = path.join(home, 'config.toml');
    add(file, '用户配置');
    if (profile && fs.existsSync(file))
      try {
        const values = require('smol-toml').parse(fs.readFileSync(file, 'utf8')).profiles?.[
          profile
        ];
        if (values)
          layers.push({
            file,
            source: '启动配置档',
            values: Object.fromEntries(
              ['model', 'model_provider', 'model_catalog_json']
                .filter((k) => values[k] !== undefined)
                .map((k) => [k, values[k]]),
            ),
          });
      } catch {}
  }
  if (cwd) {
    const dirs = [];
    let d = path.resolve(cwd);
    for (let i = 0; i < 30; i++) {
      dirs.unshift(d);
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
    for (const dir of dirs)
      add(path.join(dir, '.codex', 'config.toml'), '项目配置（是否加载取决于信任与客户端）');
  }
  if (Object.keys(overrides).length) layers.push({ source: '启动参数', values: overrides });
  return layers;
}
function records(bridgeHome) {
  const dir = path.join(bridgeHome, 'clients');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => readJson(path.join(dir, n)))
    .filter((x) => x && Date.now() - x.seenAt < 15000);
}
function heartbeat(bridgeHome, input) {
  const id = String(input.id || '');
  if (!/^[\w-]{8,80}$/.test(id)) throw Error('客户端编号无效');
  const file = path.join(bridgeHome, 'clients', id + '.json'),
    prior = readJson(file, {});
  const row = {
    id,
    pid: Number(input.pid),
    name: String(input.name || 'VS Code'),
    workspace: String(input.workspace || ''),
    home: input.home ? String(input.home) : null,
    windowKey: input.windowKey ? String(input.windowKey) : null,
    extensionPath: input.extensionPath ? String(input.extensionPath) : null,
    codexExe: input.codexExe ? String(input.codexExe) : null,
    remote: input.remote ? String(input.remote) : null,
    wsl: !!input.wsl,
    companionVersion: input.companionVersion || null,
    reloadProtocol: input.reloadProtocol || 0,
    seenAt: Date.now(),
    command: prior.command || null,
    lastAck: prior.lastAck || null,
  };
  if (input.ack && (row.command?.id === input.ack || row.lastAck?.id === input.ack)) {
    row.lastAck = {
      id: input.ack,
      at: Date.now(),
      status: input.ackStatus || 'accepted',
      error: input.ackError || null,
    };
    if (row.command?.id === input.ack) row.command = null;
  }
  // 新扩展宿主启动后回报上次重载编号；只有编号匹配才能把“已接收”推进到“扩展已重载”。
  const completed = input.completedReload;
  if (completed && /^[\w-]{8,80}$/.test(completed.clientId || '')) {
    const oldFile = path.join(bridgeHome, 'clients', completed.clientId + '.json');
    const old = readJson(oldFile);
    if (old?.lastAck?.id === completed.commandId && old.lastAck.status === 'reload_requested') {
      old.lastAck = { ...old.lastAck, status: 'reloaded', at: Date.now() };
      row.lastAck = old.lastAck;
      writeJson(oldFile, old);
    }
  }
  writeJson(file, row);
  return { command: row.command };
}
function snapshot(codexHome, bridgeHome, { inventory = scan() } = {}) {
  const all = inventory.ancestry,
    windows = records(bridgeHome).filter((w) => all.some((p) => p.pid === w.pid));
  const effect = require('../config/switch-state.cjs').readEffect(codexHome, bridgeHome);
  const clients = inventory.processes
    .map((p) => {
      const ancestors = ancestryOf(p, all),
        auxiliary = ancestors.some(
          (a) =>
            /^node_repl(?:\.exe)?$/i.test(a.name || '') ||
            /[\\/]runtimes[\\/]cua_node[\\/]/i.test(a.exe || ''),
        ),
        desktopShell = [p, ...ancestors].find(isDesktop),
        desktop = !auxiliary && !!desktopShell,
        editor = ancestors.find((a) =>
          /^(Code|Code - Insiders|Cursor|Windsurf)(?:\.exe| Helper(?: \(Plugin\))?)?$/i.test(
            a.name || '',
          ),
        );
      const context = p.context || {},
        tool = /codex-bridge-validate-|[\\/]accounts[\\/](login|[a-f0-9]{20})([\\/]|$)/i.test(
          context.cwd || '',
        );
      let kind = 'cli';
      if (tool) kind = 'tool';
      else if (auxiliary) kind = 'auxiliary';
      else if (desktop) kind = 'desktop';
      else if (editor || /openai\.chatgpt[-\\/]/i.test(p.exe || '')) kind = 'ide';
      const byProcess = windows.find(
        (w) =>
          !w.remote && !w.wsl && (w.pid === p.parentPid || ancestors.some((a) => a.pid === w.pid)),
      );
      // 通信标识可能属于整个 VS Code 实例；不能先匹配它而抢走另一个窗口的后端。
      const byHook = windows.filter(
        (w) => !w.remote && !w.wsl && w.windowKey && w.windowKey === context.windowKey,
      );
      const companion = byProcess || (byHook.length === 1 ? byHook[0] : null);
      const shared = sameHome(context.home, codexHome),
        layers = configLayers(context.home, context.cwd, context.profile, context.overrides);
      const stale = shared && !!effect && Date.parse(p.startedAt) < Date.parse(effect.at);
      return {
        id: 'process-' + p.pid,
        pid: p.pid,
        kind,
        executable: p.exe || null,
        desktopExecutable: desktopShell?.exe || null,
        desktopPid: desktopShell?.pid || null,
        name:
          kind === 'auxiliary'
            ? '自动化工具辅助后台'
            : kind === 'desktop'
              ? 'Codex 桌面端'
              : kind === 'ide'
                ? (editor?.name?.replace('.exe', '') || '编辑器') + ' · Codex'
                : kind === 'tool'
                  ? '切换器校验进程'
                  : 'Codex CLI / app-server',
        home: context.home || null,
        homeSource: context.homeSource || null,
        confirmed: !!context.ok,
        shared,
        startedAt: p.startedAt,
        stale,
        cwd: context.cwd || null,
        profile: context.profile || null,
        layers,
        overridden: layers.some(
          (l) =>
            ['启动配置档', '启动参数'].includes(l.source) && Object.keys(l.values || {}).length,
        ),
        editorId: companion?.id || null,
        error: context.error || null,
      };
    })
    .filter(
      (p, index, rows) =>
        p.kind !== 'tool' &&
        // 有后端就按它的实际配置归属展示；桌面壳仅补足没有后端的空闲状态。
        !(
          p.kind === 'desktop' &&
          p.pid === p.desktopPid &&
          rows.some(
            (other) =>
              other.kind === 'desktop' && other.desktopPid === p.pid && other.pid !== p.pid,
          )
        ),
    );
  for (const w of windows) {
    // 伴随扩展的环境只是候选信息；重载归属必须由真实 Codex 后端进程确认，
    // 否则可能把独立 CODEX_HOME 的窗口误判为共享配置。
    const matching = clients.filter((c) => c.editorId === w.id);
    const confirmed = matching.filter((x) => x.confirmed),
      shared = confirmed.some((x) => x.shared);
    clients.push({
      id: 'editor-' + w.id,
      editorId: w.id,
      pid: w.pid,
      kind: 'editor',
      name: w.name,
      workspace: w.workspace,
      remote: w.remote,
      wsl: w.wsl,
      home: confirmed[0]?.home || w.home,
      confirmed: !!confirmed.length,
      shared: !!shared,
      stale: matching.some((x) => x.stale),
      canReload: !!shared && !w.remote && !w.wsl,
      commandPending: !!w.command,
      lastAck: w.lastAck,
      companionVersion: w.companionVersion,
      reloadProtocol: w.reloadProtocol,
      layers: matching[0]?.layers || [],
      cwd: w.workspace,
    });
  }
  return {
    home: codexHome,
    clients: clients.filter((c) => c.kind !== 'auxiliary'),
    auxiliary: clients.filter((c) => c.kind === 'auxiliary'),
    desktop: clients.some((c) => c.kind === 'desktop'),
    ide: clients.filter((c) => c.kind === 'ide').length,
    other: clients.filter((c) => c.kind === 'cli').length,
    connectedEditors: windows.length,
    checkedAt: new Date().toISOString(),
  };
}
function requestReload(codexHome, bridgeHome, { id, stoppedEditors = [] } = {}) {
  const status = snapshot(codexHome, bridgeHome),
    targets = status.clients.filter(
      (c) => c.kind === 'editor' && c.canReload && (!id || c.editorId === id),
    );
  // 本次切换已核对并停止的后端不再出现在进程列表中，仍向原窗口发送重载。
  for (const editor of stoppedEditors)
    if ((!id || editor.editorId === id) && !targets.some((c) => c.editorId === editor.editorId))
      targets.push(editor);
  if (id && !targets.length) throw Error('该窗口未连接伴随扩展，或未确认共用当前配置目录。');
  for (const c of targets) {
    const file = path.join(bridgeHome, 'clients', c.editorId + '.json'),
      row = readJson(file);
    row.command = { id: crypto.randomUUID(), type: 'reload', at: Date.now() };
    c.reloadCommandId = row.command.id;
    writeJson(file, row);
  }
  return {
    count: targets.length,
    detectedEditors: status.ide,
    connectedEditors: status.connectedEditors,
    targets: targets.map((client) => ({
      id: client.editorId,
      name: client.name,
      workspace: client.workspace,
      commandId: client.reloadCommandId,
    })),
    message: targets.length
      ? '已向 ' + targets.length + ' 个共用配置的编辑器窗口发送重载请求，等待窗口执行。'
      : '未向任何编辑器窗口发送重载：请先接入伴随扩展，并在客户端列表确认配置目录。',
  };
}
function reloadResults(bridgeHome, targets) {
  return targets.map((target) => {
    const row = readJson(path.join(bridgeHome, 'clients', target.id + '.json'));
    const ack = row?.lastAck?.id === target.commandId ? row.lastAck : null;
    const status =
      ack?.status === 'reloaded'
        ? 'reloaded'
        : ack?.status === 'reload_failed'
          ? 'failed'
          : ack?.status === 'reload_requested'
            ? 'received'
            : row?.command?.id === target.commandId
              ? 'pending'
              : 'unconfirmed';
    return { ...target, status, error: ack?.error || null };
  });
}
function clientStatus(codexHome, bridgeHome) {
  return snapshot(codexHome, bridgeHome);
}
async function stopEditorBackends(codexHome, bridgeHome) {
  // 旧后端持有登录、运行中的回合和会话写锁。停止共用配置的 Codex 子进程，保留编辑器窗口，
  // 同步完成后再由既有重载流程恢复扩展；独立配置目录不受影响。
  const status = snapshot(codexHome, bridgeHome);
  const editors = status.clients.filter((client) => client.kind === 'editor' && client.canReload);
  const targets = status.clients.filter(
    (client) => client.kind === 'ide' && client.confirmed && client.shared,
  );
  for (const client of targets) {
    try {
      process.kill(client.pid);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 5000;
  while (targets.some((client) => alive(client.pid))) {
    if (Date.now() >= deadline) throw Error('编辑器的旧 Codex 后端尚未退出，未完成旧对话同步。');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return editors;
}
function desktopTargets(exe, codexHome, { inventory = scan({ force: true }) } = {}) {
  const allowed = new Set();
  const status = snapshot(codexHome, require('../platform/platform.cjs').dataHome(), { inventory });
  for (const client of status.clients) {
    if (
      client.kind === 'desktop' &&
      client.confirmed &&
      client.shared &&
      sameHome(client.desktopExecutable, exe)
    )
      allowed.add(client.desktopPid);
  }
  for (let pass = 0; pass < 5; pass++)
    for (const p of inventory.ancestry)
      if (allowed.has(p.parentPid) && p.exe && sameHome(p.exe, exe)) allowed.add(p.pid);
  return [...allowed];
}
module.exports = {
  reloadResults,
  clientStatus,
  snapshot,
  heartbeat,
  requestReload,
  sameHome,
  configLayers,
  desktopTargets,
  stopEditorBackends,
  scan,
};
