'use strict';
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  http = require('node:http');
function post(connection, route, data) {
  return new Promise((resolve, reject) => {
    const u = new URL(connection.url);
    const q = http.request(
      new URL('/api/' + route, u.origin),
      {
        method: 'POST',
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
    q.setTimeout(3000, () => q.destroy(Error('switcher unavailable')));
    q.on('error', reject);
    q.end(JSON.stringify(data));
  });
}
function activate(context) {
  const vscode = require('vscode'),
    id = crypto.randomUUID();
  let busy = false,
    stopped = false,
    completedReload = context.workspaceState.get('codexSwitcher.pendingReload');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20);
  status.text = '$(plug) Codex Switcher';
  status.command = 'codexSwitcher.connect';
  status.tooltip = 'Connect to the local Codex switcher';
  status.show();
  context.subscriptions.push(status);
  const report = () => {
    const folders = vscode.workspace.workspaceFolders || [],
      remote =
        folders.find((f) => f.uri.scheme === 'vscode-remote')?.uri.authority ||
        vscode.env.remoteName ||
        null;
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
      reloadProtocol: 2,
      pid: process.pid,
      name: vscode.env.appName,
      editorKind: vscode.env.appName || '编辑器',
      workspace: folders.map((f) => f.uri.fsPath).join(' | '),
      windowKey: process.env.VSCODE_IPC_HOOK_CLI || null,
      home:
        remote || wsl
          ? null
          : path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')),
      extensionPath: remote || wsl ? null : extensionPath,
      extensionId: codexExtension?.id || null,
      extensionName: codexExtension?.packageJSON?.displayName || null,
      codexExe: !remote && !wsl && candidate && fs.existsSync(candidate) ? candidate : null,
      remote,
      wsl,
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
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      const c = connection(),
        data = report(),
        r = await post(c, 'clientHeartbeat', { ...data, completedReload });
      if (completedReload && r.connection.state === 'ready') {
        await context.workspaceState.update('codexSwitcher.pendingReload', undefined);
        completedReload = undefined;
      }
      // HTTP 心跳成功只说明连上后台；必须与真实本机 Codex 后端关联，
      // 才显示可自动重载，避免和网页的“未关联”提示相互矛盾。
      const labels = {
        ready: '已接入',
        unmatched: '后端未关联',
        separate: '独立配置',
      };
      status.tooltip =
        new URL(c.url).origin +
        '\n切换器目录：' +
        r.connection.home +
        '\n已关联 Codex PID：' +
        (r.connection.backendPids.join(', ') || '无');
      status.text = '$(plug) Codex Switcher · ' + labels[r.connection.state];
      if (r.command?.type === 'reload') {
        // 后台只给已确认共用配置的本机后端派发命令；远程窗口标签
        // 不再重复否决它，否则会出现“已关联但拒绝重载”。
        await post(c, 'clientHeartbeat', {
          ...data,
          ack: r.command.id,
          ackStatus: 'reload_requested',
        });
        await context.workspaceState.update('codexSwitcher.lastReload', r.command.id);
        await context.workspaceState.update('codexSwitcher.pendingReload', {
          clientId: id,
          commandId: r.command.id,
        });
        setTimeout(async () => {
          try {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
          } catch (error) {
            await context.workspaceState.update('codexSwitcher.pendingReload', undefined);
            // 请求已收到但编辑器未能执行时，不能继续显示为成功或误报服务未运行。
            await post(c, 'clientHeartbeat', {
              ...data,
              ack: r.command.id,
              ackStatus: 'reload_failed',
              ackError: error.message,
            }).catch(() => {});
          }
        }, 200);
      }
    } catch (error) {
      status.text = '$(debug-disconnect) Codex Switcher · 未连接';
      status.tooltip = '未连接切换器：' + error.message;
    } finally {
      busy = false;
    }
  }
  context.subscriptions.push(vscode.commands.registerCommand('codexSwitcher.connect', tick));
  const timer = setInterval(tick, 2000);
  context.subscriptions.push({
    dispose() {
      stopped = true;
      clearInterval(timer);
    },
  });
  tick();
}
exports.activate = activate;
