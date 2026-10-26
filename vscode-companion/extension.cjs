'use strict';
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  http = require('node:http');
function post(connection, route, data, signal, method = 'POST', timeout = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(connection.url);
    const q = http.request(
      new URL('/api/' + route, u.origin),
      {
        method,
        signal,
        headers: { Authorization: 'Bearer ' + u.hash.slice(1), 'content-type': 'application/json' },
      },
      (r) => {
        let text = '';
        r.on('data', (d) => (text += d));
        r.on('end', () => {
          try {
            const j = JSON.parse(text);
            r.statusCode === 200 ? resolve(j) : reject(Error(j.error));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    q.setTimeout(timeout, () => q.destroy(Error('switcher unavailable')));
    q.on('error', reject);
    q.end(JSON.stringify(data));
  });
}
function activate(context) {
  const vscode = require('vscode'),
    id = crypto.randomUUID();
  let busy = false,
    stopped = false,
    longPoll = false,
    timer,
    completedReload = context.workspaceState.get('codexSwitcher.pendingReload'),
    remoteAgentState = 'checking',
    remoteAgentFlight = null,
    remoteAgentGeneration = 0,
    remoteRestart = null;
  const controller = new AbortController();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20);
  status.text = '$(plug) Codex Switcher';
  // 点击状态栏打开快捷切换列表。
  status.command = 'codexSwitcher.quickSwitch';
  status.tooltip = 'Connect to the local Codex switcher';
  status.show();
  context.subscriptions.push(status);
  // Remote-SSH 窗口的扩展可能运行在远端 extension host；只有这时才能
  // 读取远端 CODEX_HOME，并由同一主机上的切换器扫描远端 Codex 后端。
  const runsOnRemoteHost = context.extensionUri?.scheme === 'vscode-remote';
  // Remote-SSH 窗口里本扩展在本机运行时，服务器上的 Codex 只能经服务器端的远端代理读写。
  // 远端代理没装时命令不存在，记为 null；每 30 秒问一次，写入或安装后立即重问。
  const sshRemote = () => !runsOnRemoteHost && vscode.env.remoteName === 'ssh-remote';
  // remoteAgentError 记下最近一次问不到远端代理的原因，随心跳交给后台写日志。
  let remoteAgent = null,
    remoteAgentError = null,
    remoteCheckedAt = 0;
  function refreshRemoteAgent() {
    if (!sshRemote()) return;
    if (remoteRestart && Date.now() >= remoteRestart.until) remoteRestart = null;
    const interval = remoteRestart ? 2000 : remoteAgentState === 'unreachable' ? 5000 : 30000;
    if (remoteAgentFlight || Date.now() - remoteCheckedAt < interval) return;
    remoteCheckedAt = Date.now();
    const generation = ++remoteAgentGeneration;
    remoteAgentFlight = (async () => {
      try {
        const s = await Promise.race([
          vscode.commands.executeCommand('codexSwitcherRemote.status'),
          new Promise((_, reject) => setTimeout(() => reject(Error('远端代理状态查询超时')), 5000)),
        ]);
        if (generation !== remoteAgentGeneration) return;
        // 只转发约定字段，远端代理多给的内容不上报。
        remoteAgent = {
          agentVersion: s.agentVersion,
          startedAt: s.startedAt,
          protocol: s.protocol,
          host: s.host,
          platform: s.platform,
          arch: s.arch,
          codexHome: s.codexHome,
          configExists: s.configExists,
          current: s.current && {
            model: s.current.model,
            modelProvider: s.current.modelProvider,
            baseUrl: s.current.baseUrl,
          },
          account: s.account && {
            id: s.account.id,
            email: s.account.email,
            plan: s.account.plan,
            lastRefresh: s.account.lastRefresh,
          },
        };
        remoteAgentError = null;
        remoteAgentState = 'connected';
        if (remoteRestart && s.startedAt !== remoteRestart.startedAt) remoteRestart = null;
        status.text = '$(plug) Codex Switcher · 服务器已接入';
      } catch (error) {
        if (generation !== remoteAgentGeneration) return;
        remoteAgent = null;
        remoteAgentError = String(error.message).slice(0, 300);
        remoteAgentState = /command '.+' not found/.test(remoteAgentError)
          ? 'missing'
          : 'unreachable';
        status.text =
          remoteAgentState === 'unreachable'
            ? '$(plug) Codex Switcher · 服务器连接中'
            : '$(plug) Codex Switcher · 服务器未装远端代理';
      } finally {
        if (generation === remoteAgentGeneration) remoteAgentFlight = null;
      }
    })();
  }
  const report = () => {
    const folders = vscode.workspace.workspaceFolders || [],
      authority = folders.find((f) => f.uri.scheme === 'vscode-remote')?.uri.authority || null,
      remote = authority || vscode.env.remoteName || null;
    const wsl =
      process.platform === 'win32' &&
      !!vscode.workspace
        .getConfiguration('chatgpt')
        .get('runCodexInWindowsSubsystemForLinux', false);
    // 在 VS Code、Insiders、Cursor、Windsurf 中寻找当前安装的官方 Codex 扩展；
    // 不把扩展 ID 写死为一个版本，避免不同编辑器渠道改名后无法发现运行程序。
    const codexExtension = vscode.extensions.all.find((extension) => {
      const pkg = extension.packageJSON || {},
        text = [pkg.name, pkg.displayName, pkg.description].filter(Boolean).join(' ');
      return (
        (String(pkg.publisher || '').toLowerCase() === 'openai' ||
          /^openai\./i.test(pkg.name || '')) &&
        /(?:codex|chatgpt)/i.test(text)
      );
    });
    const extensionPath = codexExtension?.extensionPath || null;
    const configured = vscode.workspace.getConfiguration('chatgpt').get('cliExecutable', null);
    const bin =
        process.platform === 'darwin'
          ? 'macos-'
          : process.platform === 'win32'
            ? 'windows-'
            : 'linux-',
      cpu = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const candidate =
      configured ||
      (extensionPath &&
        path.join(
          extensionPath,
          'bin',
          bin + cpu,
          process.platform === 'win32' ? 'codex.exe' : 'codex',
        ));
    return {
      id,
      companionVersion: require('./package.json').version,
      reloadProtocol: 3,
      companionHost: runsOnRemoteHost ? 'remote' : 'local',
      pid: process.pid,
      name: vscode.env.appName,
      editorKind: vscode.env.appName || '编辑器',
      workspace: folders.map((f) => f.uri.fsPath).join(' | '),
      windowKey: process.env.VSCODE_IPC_HOOK_CLI || null,
      home:
        !runsOnRemoteHost && (remote || wsl)
          ? null
          : path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')),
      extensionPath: !runsOnRemoteHost && (remote || wsl) ? null : extensionPath,
      extensionId: codexExtension?.id || null,
      extensionName: codexExtension?.packageJSON?.displayName || null,
      codexExe:
        (!runsOnRemoteHost && (remote || wsl)) || !candidate || !fs.existsSync(candidate)
          ? null
          : candidate,
      remote,
      wsl,
      remoteProtocol: 1,
      remoteType: vscode.env.remoteName || null,
      // 没打开文件夹的 SSH 窗口拿不到 authority，用远端代理报告的主机名代替。
      authority: sshRemote()
        ? authority || (remoteAgent ? 'ssh-remote+' + remoteAgent.host : null)
        : null,
      remoteAgent: sshRemote() ? remoteAgent : null,
      remoteAgentError: sshRemote() ? remoteAgentError : null,
      remoteAgentState: sshRemote() ? remoteAgentState : null,
    };
  };
  const connection = () =>
    JSON.parse(
      fs.readFileSync(
        vscode.workspace.getConfiguration('codexSwitcher').get('connectionFile') ||
          path.join(os.homedir(), '.codex-api-switcher', 'connection.json'),
        'utf8',
      ),
    );
  const ack = (c, data, commandId, ackStatus, extra = {}) =>
    post(c, 'clientHeartbeat', { ...data, ack: commandId, ackStatus, ...extra }, controller.signal);
  const remoteRestartKey = 'codexSwitcher.remoteRestarts';
  async function planRemoteRestart() {
    if (!sshRemote()) return null;
    if (!remoteAgent || remoteAgent.protocol < 3)
      return { method: 'restartExtensionHost', reason: 'agentUpgrade' };
    const now = Date.now(),
      recent = (context.workspaceState.get(remoteRestartKey) || []).filter(
        (at) => now - at < 5 * 60 * 1000,
      );
    if (recent.length >= 2) {
      await context.workspaceState.update(remoteRestartKey, recent);
      return { method: 'restartExtensionHost', reason: 'crashLimit' };
    }
    await context.workspaceState.update(remoteRestartKey, [...recent, now]);
    return { method: 'remoteHostExit' };
  }
  // SSH 窗口让远端代理退出，由 Remote-SSH 只拉起服务器上的扩展宿主；
  // 本机宿主、窗口和 SSH 连接都保留。5 分钟内连续两次后才回退到整窗重启。
  async function reloadWindow(c, data, commandId, reload) {
    if (reload?.method === 'remoteHostExit') {
      try {
        remoteRestart = { startedAt: remoteAgent?.startedAt, until: Date.now() + 120000 };
        remoteCheckedAt = Date.now();
        await vscode.commands.executeCommand('codexSwitcherRemote.restart');
      } catch (error) {
        remoteRestart = null;
        await ack(c, data, commandId, 'reload_failed', { ackError: error.message }).catch(() => {});
      }
      return;
    }
    await context.workspaceState.update('codexSwitcher.lastReload', commandId);
    await context.workspaceState.update('codexSwitcher.pendingReload', {
      clientId: id,
      commandId,
      requestedAt: Date.now(),
    });
    setTimeout(async () => {
      try {
        await vscode.commands.executeCommand(
          sshRemote() ? 'workbench.action.restartExtensionHost' : 'workbench.action.reloadWindow',
        );
      } catch (error) {
        await context.workspaceState.update('codexSwitcher.pendingReload', undefined);
        // 请求已收到但编辑器未能执行时，不能继续显示为成功或误报服务未运行。
        await ack(c, data, commandId, 'reload_failed', { ackError: error.message }).catch(() => {});
      }
    }, 200);
  }
  // 远端读写：转调服务器端远端代理的命令，结果只放在回执里交给后台。
  // read 读配置，readAuth 读官方登录；write 可同时带配置和登录，text 为 null 时只写登录。
  async function remoteApply(c, data, command) {
    let result;
    try {
      result =
        command.step === 'write'
          ? await vscode.commands.executeCommand('codexSwitcherRemote.write', {
              text: command.text,
              expectedSha256: command.expectedSha256,
              catalog: command.catalog,
              auth: command.auth ?? null,
            })
          : await vscode.commands.executeCommand(
              command.step === 'readAuth'
                ? 'codexSwitcherRemote.readAuth'
                : 'codexSwitcherRemote.read',
            );
    } catch (error) {
      await ack(c, data, command.id, 'failed', { ackError: error.message });
      return;
    }
    if (command.step === 'write') remoteCheckedAt = 0;
    const reload = command.step === 'write' && command.reload ? await planRemoteRestart() : null;
    await ack(c, data, command.id, 'completed', {
      ackResult: reload ? { ...result, reload } : result,
    });
    if (reload) await reloadWindow(c, data, command.id, reload);
  }
  // 远端代理随切换器发行；在这个 SSH 窗口里安装，workspace 扩展会装到服务器一侧。
  async function installRemoteAgent(c, data, command) {
    const file = path.join(os.tmpdir(), 'codex-switcher-remote-' + crypto.randomUUID() + '.vsix');
    try {
      fs.writeFileSync(file, Buffer.from(command.base64, 'base64'));
      await vscode.commands.executeCommand(
        'workbench.extensions.installExtension',
        vscode.Uri.file(file),
      );
    } catch (error) {
      await ack(c, data, command.id, 'failed', { ackError: error.message });
      return;
    } finally {
      fs.rmSync(file, { force: true });
    }
    remoteCheckedAt = 0;
    const reload = await planRemoteRestart();
    await ack(c, data, command.id, 'completed', {
      ackResult: { installed: true, reload },
    });
    await reloadWindow(c, data, command.id, reload);
  }
  async function tick() {
    if (busy || stopped) return;
    clearTimeout(timer);
    if (completedReload?.requestedAt && Date.now() - completedReload.requestedAt > 120000) {
      await context.workspaceState.update('codexSwitcher.pendingReload', undefined);
      completedReload = undefined;
    }
    busy = true;
    let delay = 2000;
    try {
      refreshRemoteAgent();
      const c = connection(),
        data = report(),
        r = await post(
          c,
          'clientHeartbeat',
          {
            ...data,
            completedReload,
            ...(longPoll ? { wait: remoteRestart ? 2000 : 10000 } : {}),
          },
          controller.signal,
        );
      if (stopped) return;
      longPoll = r.longPoll === true;
      // 以后台核对后的结论为准：本机窗口要新后端已关联，远程窗口要同服务器同目录的远端代理版本一致。
      if (completedReload && r.reloadConfirmed === true) {
        await context.workspaceState.update('codexSwitcher.pendingReload', undefined);
        completedReload = undefined;
      }
      // 新后端未就绪时完成确认会立即返回，沿用原节奏，避免连续强制扫描。
      delay = longPoll && !completedReload ? 0 : 2000;
      // HTTP 心跳成功只说明连上后台；必须与真实本机 Codex 后端关联，
      // 才显示可自动重载，避免和网页的“未关联”提示相互矛盾。
      const labels = {
        ready: '已接入',
        unmatched: '后端未关联',
        separate: '独立配置',
      };
      if (sshRemote()) {
        // SSH 窗口的 Codex 跑在服务器上，本机本来就关联不到后端；改看服务器上的远端代理。
        status.text =
          '$(plug) Codex Switcher · ' +
          (remoteAgentState === 'checking'
            ? '服务器检查中'
            : remoteAgentState === 'unreachable'
              ? '服务器连接中'
              : !remoteAgent
                ? '服务器未装远端代理'
                : remoteAgent.protocol < 3 || remoteAgent.agentVersion !== data.companionVersion
                  ? '远端代理需更新'
                  : '服务器已接入');
        status.tooltip = remoteAgent
          ? '服务器 ' +
            remoteAgent.host +
            '\nCodex 目录：' +
            remoteAgent.codexHome +
            '\n在切换器的“远程服务器”页为这台服务器单独切换'
          : '在切换器的“远程服务器”页为这台服务器安装远端代理';
      } else {
        status.tooltip =
          new URL(c.url).origin +
          '\n切换器目录：' +
          r.connection.home +
          '\n已关联 Codex PID：' +
          (r.connection.backendPids.join(', ') || '无');
        status.text = '$(plug) Codex Switcher · ' + labels[r.connection.state];
      }
      if (r.command?.type === 'reload') {
        // 后台只给已确认共用配置的本机后端派发命令；远程窗口标签
        // 不再重复否决它，否则会出现“已关联但拒绝重载”。
        await ack(c, data, r.command.id, 'reload_requested');
        await reloadWindow(c, data, r.command.id);
      } else if (r.command?.type === 'remoteReload') {
        const reload = await planRemoteRestart();
        await ack(c, data, r.command.id, 'completed', { ackResult: { reload } });
        await reloadWindow(c, data, r.command.id, reload);
      } else if (r.command?.type === 'remoteApply') await remoteApply(c, data, r.command);
      else if (r.command?.type === 'installRemoteAgent')
        await installRemoteAgent(c, data, r.command);
    } catch (error) {
      if (stopped) return;
      delay = 5000;
      status.text = '$(debug-disconnect) Codex Switcher · 未连接';
      status.tooltip = '未连接切换器：' + error.message;
    } finally {
      busy = false;
      // 一次请求结束才安排下一次；新服务连续长轮询，旧服务仍保持原来的两秒间隔。
      if (!stopped) timer = setTimeout(tick, delay);
    }
  }
  // 状态栏快捷切换：点击时才向切换器取账号和 API，选中、确认后调用和网页同一个切换接口。
  // 本机窗口切本机；SSH 窗口只列这台服务器能用的来源，切这台服务器。
  const quotaLeft = (q) => {
    if (q?.status !== 'ok' || !q.buckets?.length) return null;
    const bucket = q.buckets.find((b) => b.id === 'codex') || q.buckets[0];
    // 已经重置过的窗口不能再用旧比例。
    const live = bucket.windows.filter((w) => !w.resetsAt || w.resetsAt * 1000 > Date.now());
    return live.length ? Math.min(...live.map((w) => w.remainingPercent)) : null;
  };
  const ago = (iso) => {
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return minutes < 60
      ? minutes + ' 分钟前'
      : minutes < 1440
        ? Math.round(minutes / 60) + ' 小时前'
        : Math.round(minutes / 1440) + ' 天前';
  };
  const sameUrl = (x, y) => x.replace(/\/+$/, '') === y.replace(/\/+$/, '');
  function accountItem(a, using) {
    const left = quotaLeft(a.quota),
      tags = [
        using && '正在使用',
        left !== null && left <= 20 && '额度低',
        a.subscriptionUntil && Date.parse(a.subscriptionUntil) < Date.now() && '会员已到期',
      ].filter(Boolean);
    return {
      label: '$(account) ' + a.label,
      description: [a.plan, tags.join(' · ')].filter(Boolean).join(' · '),
      detail:
        left === null
          ? '额度尚未读取'
          : '额度剩余 ' + Math.round(left) + '%（' + ago(a.quota.checkedAt) + '读取）',
      // 正在用的排最前；其余额度充足的在前、额度低和未读取的在后。
      rank: using ? 0 : left === null ? 2 : left > 20 ? 1 : 3,
      left: left ?? -1,
      target: { kind: 'account', id: a.id, name: a.label },
    };
  }
  async function quickSwitch() {
    let c;
    try {
      c = connection();
    } catch {
      vscode.window.showErrorMessage('没有找到正在运行的 Codex 切换器，请先启动切换器。');
      return;
    }
    const open = () => vscode.env.openExternal(vscode.Uri.parse(c.url));
    const remote = sshRemote();
    if (remote && (!remoteAgent || remoteAgent.protocol < 3)) {
      const choice = await vscode.window.showWarningMessage(
        '这台服务器还没有接入可用的远端代理，请先在切换器的“远程服务器”页安装或更新。',
        '打开切换器',
      );
      if (choice) open();
      return;
    }
    // 列表先弹出（显示加载中），数据到了再填，点击后立即有反应。
    let picked;
    try {
      picked = await vscode.window.showQuickPick(loadItems(c, remote), {
        placeHolder: remote
          ? '切换服务器 ' + remoteAgent.host + ' 使用的账号或 API（本机不受影响）'
          : '切换本机 Codex 使用的账号或 API',
        matchOnDescription: true,
        matchOnDetail: true,
      });
    } catch (error) {
      vscode.window.showErrorMessage('读取切换器失败：' + error.message);
      return;
    }
    if (!picked) return;
    const t = picked.target,
      what = t.kind === 'account' ? '官方账号「' + t.name + '」' : '「' + t.name + '」· ' + t.model;
    const confirmed = await vscode.window.showWarningMessage(
      remote
        ? '把服务器 ' +
            remoteAgent.host +
            ' 切换到' +
            what +
            '？' +
            // 和网页一致：官方登录会写到服务器上，需要明确告知。
            (t.kind === 'account'
              ? '这个账号的登录会保存到服务器上（只有当前用户可读）；本机和服务器同时用这个账号时，切换器会让两边登录保持一致。'
              : 'API 地址、模型和密钥会写入服务器的 config.toml（只有当前用户可读）。') +
            '会重启服务器上的扩展（SSH 不断开，约 20 秒后恢复）；服务器上正在运行的 Codex 任务会中断。本机不受影响。'
        : '把本机 Codex 切换到' +
            what +
            '？Codex 桌面端会重启，已接入、共用这份配置的编辑器窗口会重载，正在运行的 Codex 任务会中断。',
      { modal: true },
      '切换',
    );
    if (confirmed !== '切换') return;
    const source = remote ? 'vscode-ssh' : 'vscode-local';
    const request = remote
      ? [
          'remoteSwitch',
          t.kind === 'account'
            ? { authority: report().authority, accountId: t.id, source }
            : { authority: report().authority, providerId: t.id, model: t.model, source },
        ]
      : t.kind === 'account'
        ? ['accountSwitch', { id: t.id, reloadEditors: true, source }]
        : ['desktopSwitch', { id: t.id, model: t.model, reloadEditors: true, source }];
    try {
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '正在切换到' + what + '…' },
        // 服务器读写各有 30 秒上限，等待时间放宽到 2 分钟。
        () => post(c, request[0], request[1], undefined, 'POST', 120000),
      );
      const failed = (r.results || []).filter((x) => x.status !== 'synced');
      if (failed.length)
        throw Error(failed.map((x) => x.codexHome + '：' + (x.reason || x.status)).join('；'));
      vscode.window.showInformationMessage(
        remote ? '已写入服务器，正在重启扩展让 Codex 换上新配置。' : r.message || '已开始切换。',
      );
    } catch (error) {
      const choice = await vscode.window.showErrorMessage(
        '切换失败：' + error.message,
        '打开切换器',
      );
      if (choice) open();
    }
  }
  async function loadItems(c, remote) {
    const [state, accounts] = await Promise.all([
      post(c, 'state', undefined, undefined, 'GET'),
      post(c, 'accounts', {}),
    ]);
    const official = remote
      ? !remoteAgent.current?.modelProvider || remoteAgent.current.modelProvider === 'openai'
      : state.current.official;
    const accountItems = accounts.items
      .map((a) =>
        accountItem(a, official && (remote ? remoteAgent.account?.id === a.id : a.current)),
      )
      .sort((x, y) => x.rank - y.rank || y.left - x.left);
    // 服务器连不到本机转换服务，只列直连且有密钥的 API；本机列出有密钥（或本机代理）的 API。
    const apis = state.providers.filter(
      (p) =>
        p.id !== 'official' &&
        (remote ? p.access?.mode === 'direct' && p.hasKey : p.hasKey || p.local),
    );
    const apiItems = apis.map((p) => {
      const using = remote
        ? !official &&
          !!remoteAgent.current?.baseUrl &&
          sameUrl(remoteAgent.current.baseUrl, p.baseUrl)
        : p.inUse;
      return {
        label: '$(plug) ' + p.name,
        description: [
          { direct: '直连', adapter: '经本机转换' }[p.access?.mode] || '未检测',
          p.model,
          using && '正在使用',
        ]
          .filter(Boolean)
          .join(' · '),
        detail: p.baseUrl.replace(/^https?:\/\//, ''),
        target: { kind: 'api', id: p.id, name: p.name, model: p.model },
      };
    });
    const separator = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });
    return [
      ...(accountItems.length ? [separator('官方账号'), ...accountItems] : []),
      ...(apiItems.length ? [separator('自定义 API'), ...apiItems] : []),
    ];
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('codexSwitcher.quickSwitch', quickSwitch),
  );
  context.subscriptions.push(vscode.commands.registerCommand('codexSwitcher.connect', tick));
  context.subscriptions.push({
    dispose() {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    },
  });
  tick();
}
exports.activate = activate;
