'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
let backend;

// 在真实扩展宿主中启动官方 Codex 后端，不登录账号、不发起推理请求。
function activate(context) {
  const vscode = require('vscode');
  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const trace = (message) =>
    fs.appendFileSync(path.join(folder, 'fixture-trace.log'), message + '\n');
  trace('activate extension host ' + process.pid);
  const config = JSON.parse(fs.readFileSync(path.join(folder, 'fixture.json'), 'utf8'));
  backend = cp.spawn(config.executable, ['app-server'], {
    env: { ...process.env, CODEX_HOME: config.home },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  backend.on('error', (error) => trace(error.stack));
  backend.on('exit', (code) => trace('backend exited ' + code));
  backend.stderr.on('data', (chunk) => trace(String(chunk)));
  let output = '';
  backend.stdout.on('data', (chunk) => {
    output += chunk;
    trace(String(chunk));
    while (output.includes('\n')) {
      const at = output.indexOf('\n');
      const line = output.slice(0, at);
      output = output.slice(at + 1);
      const message = JSON.parse(line);
      if (message.id === 1 && message.result) {
        // 读取官方后端真正加载的配置，不能仅以磁盘文件变更当作客户端已生效。
        backend.stdin.write(
          JSON.stringify({ id: 2, method: 'config/read', params: { includeLayers: false } }) + '\n',
        );
      }
      if (message.id === 2 && message.result) {
        backend.stdout.removeAllListeners('data');
        fs.appendFileSync(
          path.join(folder, 'activations.jsonl'),
          JSON.stringify({
            extensionHostPid: process.pid,
            backendPid: backend.pid,
            configuration: message.result.config,
          }) + '\n',
        );
      }
    }
  });
  backend.stdin.write(
    JSON.stringify({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'switcher-editor-fixture', version: '1' } },
    }) + '\n',
  );
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(folder, 'stop')))
      vscode.commands.executeCommand('workbench.action.quit');
  }, 500);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

function deactivate() {
  backend?.kill();
}

module.exports = { activate, deactivate };
