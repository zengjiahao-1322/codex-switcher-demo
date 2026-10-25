'use strict';
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  http = require('node:http');
function post(connection, route, data, signal) {
  return new Promise((resolve, reject) => {
    const u = new URL(connection.url);
    const q = http.request(
      new URL('/api/' + route, u.origin),
      {
        method: 'POST',
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
    q.setTimeout(15000, () => q.destroy(Error('switcher unavailable')));
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
    completedReload = context.workspaceState.get('codexSwitcher.pendingReload');
  const controller = new AbortController();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20);
  status.text = '$(plug) Codex Switcher';
  status.command = 'codexSwitcher.connect';
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
  async function refreshRemoteAgent() {
    if (!sshRemote() || Date.now() - remoteCheckedAt < 30000) return;
    remoteCheckedAt = Date.now();
    try {
      const s = await vscode.commands.executeCommand('codexSwitcherRemote.status');
      // 只转发约定字段，远端代理多给的内容不上报。
      remoteAgent = {
        agentVersion: s.agentVersion,
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
    } catch (error) {
      remoteAgent = null;
      remoteAgentError = String(error.message).slice(0, 300);
    }
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
  // 记下待确认的重载后重载窗口；新窗口的心跳带 completedReload 让后台确认。
  // SSH 窗口只重启扩展宿主：Codex 后台是扩展宿主的子进程，会随之换新并读到新登录和配置，
  // 而窗口不重载、SSH 不重连，打开的文件和终端都保留（2026-10-25 隔离实测：不到 1 秒换新后台）。
  async function reloadWindow(c, data, commandId) {
    await context.workspaceState.update('codexSwitcher.lastReload', commandId);
    await context.workspaceState.update('codexSwitcher.pendingReload', {
      clientId: id,
      commandId,
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
    await ack(c, data, command.id, 'completed', { ackResult: result });
    if (command.step === 'write' && command.reload) await reloadWindow(c, data, command.id);
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
    await ack(c, data, command.id, 'completed', { ackResult: { installed: true } });
    // 不等待用户点按钮，避免阻塞心跳。
    vscode.window
      .showInformationMessage(
        '已在服务器上安装 Codex Switcher 远端代理。如果切换器里仍显示未安装，请重启扩展（不会断开服务器连接）。',
        '重启扩展',
      )
      .then((choice) => {
        if (choice === '重启扩展')
          vscode.commands.executeCommand('workbench.action.restartExtensionHost');
      });
  }
  async function tick() {
    if (busy || stopped) return;
    clearTimeout(timer);
    busy = true;
    let delay = 2000;
    try {
      await refreshRemoteAgent();
      const c = connection(),
        data = report(),
        r = await post(
          c,
          'clientHeartbeat',
          {
            ...data,
            completedReload,
            ...(longPoll ? { wait: 10000 } : {}),
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
          (!remoteAgent
            ? '服务器未装远端代理'
            : remoteAgent.protocol !== 2 || remoteAgent.agentVersion !== data.companionVersion
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
