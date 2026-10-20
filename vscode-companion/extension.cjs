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
    const wsl = !!vscode.workspace
      .getConfiguration('chatgpt')
      .get('runCodexInWindowsSubsystemForLinux', false);
    // 直接上报 VS Code 解析到的官方扩展目录，支持自定义 extensions-dir，
    // 也避免切换器猜错当前编辑器实际使用的扩展版本。
    const extensionPath = vscode.extensions.getExtension('openai.chatgpt')?.extensionPath || null;
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
      pid: process.pid,
      name: vscode.env.appName,
      workspace: folders.map((f) => f.uri.fsPath).join(' | '),
      windowKey: process.env.VSCODE_IPC_HOOK_CLI || null,
      home:
        remote || wsl
          ? null
          : path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')),
      extensionPath: remote || wsl ? null : extensionPath,
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
      if (completedReload) {
        await context.workspaceState.update('codexSwitcher.pendingReload', undefined);
        completedReload = undefined;
      }
      status.tooltip =
        'Connected to ' +
        new URL(c.url).origin +
        ' · ' +
        (data.home || 'separate remote/WSL environment');
      status.text = '$(plug) Codex Switcher · 已连接';
      if (r.command?.type === 'reload') {
        if (data.remote || data.wsl) {
          await post(c, 'clientHeartbeat', {
            ...data,
            ack: r.command.id,
            ackStatus: 'different_environment',
          });
          return;
        }
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
