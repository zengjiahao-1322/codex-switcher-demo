'use strict';
const { PROJECT_ROOT } = require('../paths.cjs');

const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  cp = require('node:child_process');
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
const isEditor = (p) =>
  /^(Code|Code - Insiders|Cursor|Windsurf)(?:\.exe| Helper(?: \(Plugin\))?)?$/i.test(p.name || '');
let cached, scanning;
const windowsHelper = path.join(PROJECT_ROOT, 'bin', 'process-context.exe');
function requireWindowsHelper() {
  if (!fs.existsSync(windowsHelper))
    throw Error(
      'Windows 进程助手尚未构建，请先运行 runtime\\node.exe scripts\\build-windows-helper.cjs。',
    );
  return windowsHelper;
}
function scan({ force = false } = {}) {
  if (!force && cached && Date.now() - cached.at < 2500) return cached.value;
  const value =
    process.platform === 'darwin'
      ? require('../platform/mac-processes.cjs').scan()
      : JSON.parse(
          cp.execFileSync(requireWindowsHelper(), [], { encoding: 'utf8', windowsHide: true }),
        );
  cached = { at: Date.now(), value };
  return value;
}
async function scanAsync({ force = false } = {}) {
  if (!force && cached && Date.now() - cached.at < 2500) return cached.value;
  if (scanning) return scanning;
  // 助手在独立进程里执行，等待它时允许账号 RPC 继续收发。
  scanning = (
    process.platform === 'darwin'
      ? require('../platform/mac-processes.cjs').scanAsync()
      : new Promise((resolve, reject) => {
          cp.execFile(
            requireWindowsHelper(),
            [],
            { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
            (error, stdout, stderr) => {
              if (error) {
                reject(Error(stderr.trim() || '无法读取 Codex 进程归属。'));
                return;
              }
              try {
                const value = JSON.parse(stdout);
                resolve(value);
              } catch (error) {
                reject(error);
              }
            },
          );
        })
  )
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      scanning = null;
    });
  return scanning;
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
    .filter((x) => x && (Date.now() - x.seenAt < 15000 || x.waitUntil > Date.now()));
}
function heartbeat(bridgeHome, input) {
  const id = String(input.id || '');
  if (!/^[\w-]{8,80}$/.test(id)) throw Error('客户端编号无效');
  const file = path.join(bridgeHome, 'clients', id + '.json'),
    prior = readJson(file, {});
  const { isTrustedCodex, extensionBinary } = require('../platform/runtime.cjs');
  const remoteServers = require('./remote-servers.cjs');
  const remoteCommand = remoteServers.command(bridgeHome, id);
  const reported = input.extensionPath && extensionBinary(String(input.extensionPath));
  const row = {
    id,
    pid: Number(input.pid),
    name: String(input.name || 'VS Code'),
    workspace: String(input.workspace || ''),
    home: input.home ? String(input.home) : null,
    windowKey: input.windowKey ? String(input.windowKey) : null,
    extensionPath: isTrustedCodex(reported) ? String(input.extensionPath) : null,
    extensionId: input.extensionId ? String(input.extensionId) : null,
    extensionName: input.extensionName ? String(input.extensionName) : null,
    editorKind: input.editorKind ? String(input.editorKind) : null,
    codexExe: isTrustedCodex(input.codexExe) ? String(input.codexExe) : null,
    remote: input.remote ? String(input.remote) : null,
    remoteType: input.remoteType ? String(input.remoteType) : null,
    remoteProtocol: input.remoteProtocol || 0,
    authority: input.authority ? String(input.authority) : null,
    remoteAgent: remoteServers.agentStatus(input.remoteAgent),
    remoteAgentState: input.remoteAgentState || null,
    wsl: !!input.wsl,
    companionVersion: input.companionVersion || null,
    reloadProtocol: input.reloadProtocol || 0,
    companionHost: input.companionHost === 'remote' ? 'remote' : 'local',
    seenAt: Date.now(),
    command: prior.command || null,
    lastAck: prior.lastAck || null,
    ...(!input.ack &&
    !input.completedReload &&
    !prior.command &&
    !remoteCommand &&
    Number(input.wait) > 0
      ? { waitUntil: Date.now() + Math.min(25000, Number(input.wait)) }
      : {}),
  };
  const remoteAck = remoteServers.acknowledge(bridgeHome, input);
  if (remoteAck) row.lastAck = remoteAck;
  else if (
    row.lastAck?.remote &&
    row.lastAck.id === input.ack &&
    input.ackStatus === 'reload_failed'
  )
    (() => {
      row.lastAck = {
        ...row.lastAck,
        status: 'reload_failed',
        error: '远端窗口未能执行重载，请在编辑器中手动重载',
        at: Date.now(),
      };
      remoteServers.recordReload(bridgeHome, id, {
        status: 'failed',
        reason: input.ackError,
      });
    })();
  else if (
    input.ack &&
    (row.command?.id === input.ack || (row.lastAck?.id === input.ack && !row.lastAck.remote))
  ) {
    const ack = {
      id: input.ack,
      status: input.ackStatus || 'accepted',
      error: input.ackError || null,
    };
    if (
      row.lastAck?.id !== ack.id ||
      row.lastAck.status !== ack.status ||
      row.lastAck.error !== ack.error
    )
      row.lastAck = { ...ack, at: Date.now() };
    if (row.command?.id === input.ack) row.command = null;
  }
  // 新扩展宿主启动后回报上次重载编号；只有编号匹配才能把“已接收”推进到“扩展已重载”。
  const completed = input.completedReload;
  let reloadConfirmed = false;
  if (remoteServers.confirmsRemoteRestart(bridgeHome, id, row)) {
    row.lastAck = { ...row.lastAck, status: 'reloaded', at: Date.now() };
    if (row.lastAck.installStatus) row.lastAck.installStatus = 'active';
    remoteServers.recordReload(bridgeHome, id, { status: 'confirmed' });
    reloadConfirmed = true;
  }
  if (completed && /^[\w-]{8,80}$/.test(completed.clientId || '')) {
    const oldFile = path.join(bridgeHome, 'clients', completed.clientId + '.json');
    const old = readJson(oldFile);
    if (
      old?.lastAck?.id === completed.commandId &&
      ['reload_requested', 'reloaded'].includes(old.lastAck.status) &&
      (!old.remoteAgent || remoteServers.hasReload(bridgeHome, completed.clientId)) &&
      (!old.remoteAgent || remoteServers.confirmsReload(input, old))
    ) {
      if (old.lastAck.status !== 'reloaded')
        old.lastAck = { ...old.lastAck, status: 'reloaded', at: Date.now() };
      if (old.lastAck.installStatus) old.lastAck.installStatus = 'active';
      row.lastAck = old.lastAck;
      reloadConfirmed = true;
      remoteServers.recordReload(bridgeHome, completed.clientId, { status: 'confirmed' });
      if (old.remoteAgent) old.seenAt = 0;
      writeJson(oldFile, old);
    }
  }
  const { seenAt: previousWrite, ...previousFields } = prior,
    { seenAt, ...fields } = row;
  // seenAt 记录实际落盘时间；五秒内无变化的心跳不重复写文件。
  if (
    Date.now() - previousWrite >= 5000 ||
    JSON.stringify(fields) !== JSON.stringify(previousFields)
  )
    writeJson(file, row);
  return {
    command: remoteServers.command(bridgeHome, id) || row.command,
    ...(completed || reloadConfirmed ? { reloadConfirmed } : {}),
  };
}
function holdHeartbeat(bridgeHome, id) {
  const file = path.join(bridgeHome, 'clients', id + '.json'),
    row = readJson(file),
    until = row.waitUntil;
  return (completed) => {
    const latest = readJson(file);
    if (latest.waitUntil !== until) return;
    delete latest.waitUntil;
    if (completed) latest.seenAt = Date.now();
    writeJson(file, latest);
  };
}
const commandWatchers = new Map();
function watchCommands(directory, id, check, failed) {
  let shared = commandWatchers.get(directory);
  if (!shared) {
    const listeners = new Set();
    const changed = (name) => {
      for (const listener of listeners)
        if (name === null || name === listener.id + '.json') listener.check();
    };
    const failed = (error) => {
      for (const listener of [...listeners]) listener.failed(error);
    };
    let watcher;
    if (process.platform === 'darwin') {
      const child = cp.spawn(
        path.join(PROJECT_ROOT, 'bin', 'mac-process-context'),
        ['--watch-commands', directory],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let closed = false,
        error = '';
      child.stdout.on('data', () => changed(null));
      child.stderr.on('data', (data) => {
        error += data;
      });
      child.once('error', failed);
      child.once('exit', (code) => {
        if (!closed) failed(Error('Command watcher exited ' + code + ': ' + error.trim()));
      });
      watcher = {
        close() {
          closed = true;
          child.stdin.end();
        },
      };
    } else {
      watcher = fs.watch(directory, (_event, name) => changed(name));
      watcher.on('error', failed);
    }
    shared = { listeners, watcher };
    commandWatchers.set(directory, shared);
  }
  const listener = { id, check, failed };
  shared.listeners.add(listener);
  return () => {
    shared.listeners.delete(listener);
    if (!shared.listeners.size) {
      shared.watcher.close();
      commandWatchers.delete(directory);
    }
  };
}
function waitForCommand(bridgeHome, id, wait, signal) {
  const file = path.join(bridgeHome, 'clients', id + '.json');
  return new Promise((resolve, reject) => {
    const remote = require('./remote-servers.cjs');
    const finish = (error, command = null) => {
      unwatch();
      unsubscribe();
      clearTimeout(timeout);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve(command);
    };
    const check = () => {
      try {
        const command = remote.command(bridgeHome, id);
        if (command) return finish(null, command);
        const row = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (row.command) finish(null, row.command);
      } catch (error) {
        finish(error);
      }
    };
    const aborted = () => finish(null),
      unwatch = watchCommands(path.dirname(file), id, check, (error) => finish(error)),
      unsubscribe = remote.onCommand(bridgeHome, id, check),
      timeout = setTimeout(() => finish(null), wait);
    signal?.addEventListener('abort', aborted, { once: true });
    // 扫描进程期间也可能刚写入命令，开始等待时先读一次，避免漏掉这次变化。
    if (signal?.aborted) aborted();
    else check();
  });
}
function snapshot(codexHome, bridgeHome, { inventory = scan() } = {}) {
  const all = inventory.ancestry,
    // 远程 extension host 的 PID 不在本机进程表中，但心跳仍是已认证的窗口登记。
    // 本机窗口仍必须通过 PID/祖先链确认，避免过期记录抢占本机后端。
    windows = records(bridgeHome).filter((w) => w.remote || all.some((p) => p.pid === w.pid));
  const effect = require('../config/switch-state.cjs').readEffect(codexHome, bridgeHome);
  const clients = inventory.processes
    .map((p) => {
      const ancestors = ancestryOf(p, all),
        auxiliary = ancestors.some(
          (a) =>
            /^node_repl(?:\.exe)?$/i.test(a.name || '') ||
            /[\\/]runtimes[\\/]cua_node[\\/]/i.test(a.exe || ''),
        ),
        ideRuntime = /openai\.chatgpt[-\\/]/i.test(p.exe || ''),
        // 取最近的客户端宿主：编辑器可能由桌面端的终端启动，不能沿祖先链误归到桌面端。
        host = [p, ...ancestors].find(
          (a) => isDesktop(a) || isEditor(a) || windows.some((w) => w.pid === a.pid),
        ),
        desktopShell = !ideRuntime && host && isDesktop(host) ? host : null,
        desktop = !auxiliary && !!desktopShell,
        editor = ancestors.find(isEditor);
      const context = p.context || {},
        tool = /codex-bridge-validate-|[\\/]accounts[\\/](login|[a-f0-9]{20})([\\/]|$)/i.test(
          context.cwd || '',
        );
      let kind = 'cli';
      if (tool) kind = 'tool';
      else if (auxiliary) kind = 'auxiliary';
      else if (desktop) kind = 'desktop';
      else if (host || ideRuntime) kind = 'ide';
      const byProcess = windows.find(
        (w) => w.pid === p.parentPid || ancestors.some((a) => a.pid === w.pid),
      );
      // 通信标识可能属于整个 VS Code 实例；不能先匹配它而抢走另一个窗口的后端。
      const byHook = windows.filter((w) => w.windowKey && w.windowKey === context.windowKey);
      const byHome = windows.filter(
        (w) => w.companionHost === 'remote' && sameHome(w.home, context.home),
      );
      // 远端窗口和远端后端可能不共享本机 PID 链；只有同一远端目录且唯一窗口时才按目录关联。
      const companion =
        byProcess || (byHook.length === 1 ? byHook[0] : byHome.length === 1 ? byHome[0] : null);
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
      remoteType: w.remoteType,
      authority: w.authority,
      remoteAgent: w.remoteAgent,
      wsl: w.wsl,
      home: confirmed[0]?.home || w.home,
      confirmed: !!confirmed.length,
      shared: !!shared,
      stale: matching.some((x) => x.stale),
      // 是否共用本机配置由真实后端决定。远程工作区也可能使用本机 Codex，
      // 不能用工作区类型或 WSL 设置否定已经确认的本地进程归属。
      canReload: !!shared,
      commandPending: !!w.command,
      lastAck: w.lastAck,
      companionVersion: w.companionVersion,
      companionHost: w.companionHost,
      heartbeatAgeSec: Math.floor((Date.now() - w.seenAt) / 1000),
      extensionId: w.extensionId,
      extensionName: w.extensionName,
      editorKind: w.editorKind || w.name,
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
function requestReload(
  codexHome,
  bridgeHome,
  { id, stoppedEditors = [], onlyStopped = false } = {},
) {
  const status = onlyStopped
      ? { clients: [], ide: 0, connectedEditors: records(bridgeHome).length }
      : snapshot(codexHome, bridgeHome),
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
      ? '已向 ' + targets.length + ' 个已接入的编辑器窗口发送重载请求，等待窗口执行。'
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
function clientStatus(codexHome, bridgeHome, options) {
  return snapshot(codexHome, bridgeHome, options);
}
// 只选取排查关联所需的字段，不把命令行、配置内容或工作区正文写入日志。
function diagnosticClients(status, inventory) {
  const processes = new Map(inventory.ancestry.map((p) => [p.pid, p])),
    editors = new Map(
      status.clients.filter((c) => c.kind === 'editor').map((c) => [c.editorId, c]),
    );
  return status.clients.map((c) => {
    const editor = editors.get(c.editorId),
      chain = [];
    for (let p = processes.get(c.pid); p && chain.length < 8; p = processes.get(p.parentPid))
      chain.push(p.pid + ':' + p.name);
    return {
      kind: c.kind,
      pid: c.pid,
      chain,
      home: c.home || null,
      homeSource: c.homeSource || null,
      confirmed: c.confirmed,
      shared: c.shared,
      editorId: c.editorId || null,
      remote: editor?.remote || null,
      wsl: !!editor?.wsl,
      companionHost: editor?.companionHost || null,
      companionVersion: editor?.companionVersion || null,
      reloadProtocol: editor?.reloadProtocol || 0,
      heartbeatAgeSec: editor?.heartbeatAgeSec ?? null,
    };
  });
}
async function stopEditorBackends(codexHome, bridgeHome, { inventory } = {}) {
  // 旧后端持有登录、运行中的回合和会话写锁。停止共用配置的 Codex 子进程，保留编辑器窗口，
  // 同步完成后再由既有重载流程恢复扩展；独立配置目录不受影响。
  const status = snapshot(codexHome, bridgeHome, {
    inventory: inventory || (await scanAsync({ force: true })),
  });
  const editors = status.clients.filter((client) => client.kind === 'editor' && client.canReload);
  const targets = status.clients.filter(
    (client) => client.kind === 'ide' && client.confirmed && client.shared,
  );
  await require('../platform/process-stop.cjs').stopProcesses(targets.map((client) => client.pid));
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
  scanAsync,
  reloadResults,
  clientStatus,
  diagnosticClients,
  snapshot,
  heartbeat,
  records,
  waitForCommand,
  holdHeartbeat,
  requestReload,
  sameHome,
  configLayers,
  desktopTargets,
  stopEditorBackends,
  scan,
};
