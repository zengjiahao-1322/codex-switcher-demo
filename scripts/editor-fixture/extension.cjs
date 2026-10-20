'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
let backend;

// 在真实扩展宿主中启动官方 Codex 后端，不登录账号、不发起推理请求。
function activate(context) {
  const vscode = require('vscode');
  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const config = JSON.parse(fs.readFileSync(path.join(folder, 'fixture.json'), 'utf8'));
  backend = cp.spawn(config.executable, ['app-server'], {
    env: { ...process.env, CODEX_HOME: config.home },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  backend.stderr.resume();
  let output = '';
  backend.stdout.on('data', (chunk) => {
    output += chunk;
    const line = output.split('\n').find((value) => value.includes('"id":1'));
    if (!line) return;
    const message = JSON.parse(line);
    if (!message.result) return;
    backend.stdout.removeAllListeners('data');
    fs.appendFileSync(
      path.join(folder, 'activations.jsonl'),
      JSON.stringify({
        extensionHostPid: process.pid,
        backendPid: backend.pid,
        configuration: fs.readFileSync(path.join(config.home, 'config.toml'), 'utf8'),
      }) + '\n',
    );
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
