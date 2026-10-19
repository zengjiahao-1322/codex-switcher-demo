'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  cp = require('node:child_process');
function editors() {
  const candidates =
    process.platform === 'darwin'
      ? ['/Applications', path.join(os.homedir(), 'Applications')].flatMap((dir) => [
          [
            'VS Code',
            path.join(dir, 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code'),
          ],
          ['Cursor', path.join(dir, 'Cursor.app', 'Contents', 'Resources', 'app', 'bin', 'cursor')],
        ])
      : [
          [
            'VS Code',
            path.join(
              process.env.LOCALAPPDATA || '',
              'Programs',
              'Microsoft VS Code',
              'bin',
              'code.cmd',
            ),
          ],
          [
            'VS Code',
            path.join(
              process.env.ProgramFiles || 'C:/Program Files',
              'Microsoft VS Code',
              'bin',
              'code.cmd',
            ),
          ],
          [
            'Cursor',
            path.join(
              process.env.LOCALAPPDATA || '',
              'Programs',
              'cursor',
              'resources',
              'app',
              'bin',
              'cursor.cmd',
            ),
          ],
        ];
  return candidates
    .filter(([, file]) => fs.existsSync(file))
    .map(([name, file], id) => ({ id, name, file }));
}
function build(projectDir = __dirname) {
  const out = path.join(
    process.env.BRIDGE_HOME ||
      (process.platform === 'darwin'
        ? require('./platform.cjs').dataHome()
        : path.join(projectDir, 'private')),
    'codex-switcher-companion.vsix',
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const src = path.join(projectDir, 'vscode-companion');
  return require('./zip.cjs').zip(
    ['package.json', 'extension.cjs', 'extension.vsixmanifest', 'content-types.xml'].map(
      (name) => ({
        name:
          name === 'extension.vsixmanifest'
            ? name
            : name === 'content-types.xml'
              ? '[Content_Types].xml'
              : 'extension/' + name,
        file: path.join(src, name),
      }),
    ),
    out,
  );
}
async function install(id, projectDir = __dirname) {
  const editor = editors().find((e) => e.id === Number(id));
  if (!editor) throw Error('未检测到该编辑器。可下载 VSIX 后在编辑器中选择“从 VSIX 安装”。');
  const file = build(projectDir);
  const { exe, cli } = cliFor(editor.file);
  await new Promise((resolve, reject) =>
    cp.execFile(
      exe,
      [cli, '--install-extension', file, '--force'],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60000 },
      (e) => (e ? reject(Error('扩展安装失败，请下载 VSIX 手动安装。')) : resolve()),
    ),
  );
  return {
    message: '已为 ' + editor.name + ' 安装伴随扩展。打开 Codex 扩展后，此窗口会出现在客户端列表。',
  };
}
function cliFor(shim) {
  if (process.platform === 'darwin') {
    const app = path.resolve(path.dirname(shim), '..'),
      macos = path.resolve(app, '..', '..', 'MacOS'),
      exe = ['Electron', 'Cursor', 'Windsurf', 'Code - Insiders']
        .map((name) => path.join(macos, name))
        .find((file) => fs.existsSync(file)),
      cli = path.join(app, 'out', 'cli.js');
    if (!exe || !fs.existsSync(cli)) throw Error('无法识别编辑器 CLI 入口');
    return { exe, cli };
  }
  const script = fs.readFileSync(shim, 'utf8'),
    match = script.match(/"([^"\r\n]+\.exe)"\s+"([^"\r\n]+cli\.(?:js|mjs))"/i);
  if (!match) throw Error('无法识别编辑器的官方 CLI 入口。请下载 VSIX 手动安装。');
  const resolve = (value) => path.resolve(path.dirname(shim), value.replace(/^%~dp0/i, ''));
  return { exe: resolve(match[1]), cli: resolve(match[2]) };
}
module.exports = { editors, build, install, cliFor };
