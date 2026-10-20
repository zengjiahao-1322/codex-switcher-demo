'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  cp = require('node:child_process');
function editors() {
  const brands = [
    ['VS Code', 'Visual Studio Code.app', 'code', 'Microsoft VS Code', 'bin'],
    [
      'VS Code Insiders',
      'Visual Studio Code - Insiders.app',
      'code-insiders',
      'Microsoft VS Code Insiders',
      'bin',
    ],
    ['Cursor', 'Cursor.app', 'cursor', 'cursor', 'resources/app/bin'],
    ['Windsurf', 'Windsurf.app', 'windsurf', 'Windsurf', 'bin'],
  ];
  let candidates;
  if (process.platform === 'darwin') {
    const apps = new Set(
      ['/Applications', path.join(os.homedir(), 'Applications')].flatMap((dir) =>
        brands.map(([, app]) => path.join(dir, app)),
      ),
    );
    // 也接入正在运行的非标准目录安装，例如用户直接从 Downloads 打开的编辑器。
    for (const process of require('./client-status.cjs').scan().ancestry) {
      const app = process.exe?.match(/^(.+?\.app)\/Contents\//)?.[1];
      if (app) apps.add(app);
    }
    candidates = [...apps].flatMap((app) =>
      brands.map(([name, , cli]) => [
        name,
        path.join(app, 'Contents', 'Resources', 'app', 'bin', cli),
      ]),
    );
  } else {
    candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'Programs'),
      process.env.ProgramFiles || 'C:/Program Files',
    ].flatMap((dir) =>
      brands.map(([name, , cli, folder, bin]) => [name, path.join(dir, folder, bin, cli + '.cmd')]),
    );
  }
  const seen = new Set();
  return candidates
    .filter(([, file]) => {
      if (!fs.existsSync(file) || seen.has(file)) return false;
      seen.add(file);
      return true;
    })
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
    message:
      '已为 ' +
      editor.name +
      ' 安装伴随扩展。请在各窗口确认状态栏显示“Codex Switcher · 已连接”；已有窗口可能需要先执行一次“重载窗口”才能启用新版本。',
  };
}
function cliFor(shim) {
  if (process.platform === 'darwin') {
    const app = path.resolve(path.dirname(shim), '..'),
      macos = path.resolve(app, '..', '..', 'MacOS'),
      name = cp
        .execFileSync(
          '/usr/libexec/PlistBuddy',
          ['-c', 'Print :CFBundleExecutable', path.resolve(app, '..', '..', 'Info.plist')],
          { encoding: 'utf8', timeout: 3000 },
        )
        .trim(),
      exe = path.join(macos, name),
      cli = path.join(app, 'out', 'cli.js');
    if (!fs.existsSync(exe) || !fs.existsSync(cli)) throw Error('无法识别编辑器 CLI 入口');
    return { exe, cli };
  }
  const script = fs.readFileSync(shim, 'utf8'),
    match = script.match(/"([^"\r\n]+\.exe)"\s+"([^"\r\n]+cli\.(?:js|mjs))"/i);
  if (!match) throw Error('无法识别编辑器的官方 CLI 入口。请下载 VSIX 手动安装。');
  const resolve = (value) => path.resolve(path.dirname(shim), value.replace(/^%~dp0/i, ''));
  return { exe: resolve(match[1]), cli: resolve(match[2]) };
}
module.exports = { editors, build, install, cliFor };
