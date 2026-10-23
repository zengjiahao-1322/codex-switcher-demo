'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  cp = require('node:child_process');
const within = (file, root) => {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  return (
    relative &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
};
function isTrustedCodex(file, options = {}) {
  if (!file || !exists(file)) return false;
  const platform = options.platform || process.platform,
    home = options.home || os.homedir(),
    env = options.env || process.env;
  if (path.basename(file).toLowerCase() !== (platform === 'win32' ? 'codex.exe' : 'codex'))
    return false;
  const roots = [
    ...['.vscode', '.vscode-insiders', '.cursor', '.windsurf'].map((name) =>
      path.join(home, name, 'extensions'),
    ),
    ...(options.extensionRoots || []),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root) || !within(file, root)) continue;
    const parts = path.relative(fs.realpathSync(root), fs.realpathSync(file)).split(path.sep);
    if (/^openai\.(?:chatgpt|codex)(?:-|$)/i.test(parts[0]) && parts[1] === 'bin') return true;
  }
  const installations =
    platform === 'win32'
      ? [
          options.windowsRoot ||
            path.join(
              env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
              'OpenAI',
              'Codex',
              'bin',
            ),
        ]
      : [
          ...(options.appPaths || require('./platform.cjs').macApps()).map((app) =>
            path.join(app, 'Contents', 'Resources'),
          ),
          '/opt/homebrew',
          '/usr/local',
          path.join(home, '.local', 'bin'),
          path.join(home, '.npm-global'),
        ];
  return installations.some((root) => fs.existsSync(root) && within(file, root));
}
const exists = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};
function newest(files) {
  return files.filter(exists).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}
function extensionBinary(dir, platform = process.platform, arch = process.arch) {
  // 官方 VSIX 的目录使用 macos-aarch64 / macos-x86_64，不能直接拼 Node 的 arm64。
  const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64',
    target =
      (platform === 'darwin' ? 'macos-' : platform === 'win32' ? 'windows-' : 'linux-') + cpu;
  const aliases =
    platform === 'darwin'
      ? [target, 'darwin-' + arch, cpu + '-apple-darwin']
      : platform === 'win32'
        ? [target, 'win32-' + arch]
        : [target];
  return (
    aliases
      .map((a) => path.join(dir, 'bin', a, platform === 'win32' ? 'codex.exe' : 'codex'))
      .find(exists) || null
  );
}
function isCodexExtension(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const text = [pkg.name, pkg.displayName, pkg.description].filter(Boolean).join(' ');
    return (
      (String(pkg.publisher || '').toLowerCase() === 'openai' ||
        /^openai\./i.test(pkg.name || '')) &&
      /(?:codex|chatgpt)/i.test(text)
    );
  } catch {
    return path.basename(dir).startsWith('openai.chatgpt-');
  }
}
function findCodex(options = {}) {
  // 查找顺序：显式环境变量、用户选择、伴随扩展上报、桌面版、官方扩展、CLI。
  // IDE 独立安装也包含完整的官方 app-server，不需要另装 Codex.app。
  if (typeof options === 'string') {
    const files = fs
      .readdirSync(options, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(options, e.name, 'codex.exe'));
    const file = newest(files)[0];
    if (file) return file;
    throw Error('未找到 Codex 运行程序');
  }
  const {
    platform = process.platform,
    arch = process.arch,
    home = os.homedir(),
    env = process.env,
    hints = [],
    appPaths,
    extensionRoots,
  } = options;
  if (env.CODEX_EXE) {
    if (exists(env.CODEX_EXE)) return env.CODEX_EXE;
    throw Object.assign(Error('CODEX_EXE 指向的文件不存在，请修正该设置。'), {
      code: 'CODEX_NOT_FOUND',
    });
  }
  const name = platform === 'win32' ? 'codex.exe' : 'codex',
    candidates = [...hints];
  if (options.platform === undefined) {
    const data = options.dataHome || require('./platform.cjs').dataHome();
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
      if (settings.codexExe) {
        if (!exists(settings.codexExe))
          throw Object.assign(Error('已选择的 Codex 程序不存在，请重新选择。'), {
            code: 'CODEX_NOT_FOUND',
          });
        if (
          !isTrustedCodex(settings.codexExe, options) &&
          settings.approvedCodexPath !== fs.realpathSync(settings.codexExe)
        )
          throw Object.assign(Error('此 Codex 程序需要重新确认后才能使用。'), {
            code: 'untrusted_codex',
          });
        return fs.realpathSync(settings.codexExe);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const clients = path.join(data, 'clients');
    if (fs.existsSync(clients))
      for (const name of fs.readdirSync(clients).filter((n) => n.endsWith('.json'))) {
        try {
          const c = JSON.parse(fs.readFileSync(path.join(clients, name), 'utf8'));
          // 编辑器关闭后仍可复用已确认存在的安装路径，方便独立打开切换器登录。
          if (!c.remote && !c.wsl) {
            if (isTrustedCodex(c.codexExe, options)) candidates.push(c.codexExe);
            const extension = c.extensionPath && extensionBinary(c.extensionPath, platform, arch);
            if (isTrustedCodex(extension, options)) candidates.push(extension);
          }
        } catch {}
      }
  }
  if (platform === 'darwin')
    for (const app of appPaths || require('./platform.cjs').macApps())
      for (const n of ['codex', 'bin/codex', 'resources/codex'])
        candidates.push(path.join(app, 'Contents', 'Resources', n));
  if (platform === 'win32') {
    const root =
      options.windowsRoot ||
      path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
    if (fs.existsSync(root))
      candidates.push(
        ...newest(
          fs
            .readdirSync(root, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => path.join(root, e.name, name)),
        ),
      );
  }
  for (const root of extensionRoots ||
    ['.vscode', '.vscode-insiders', '.cursor', '.windsurf'].map((d) =>
      path.join(home, d, 'extensions'),
    )) {
    if (!fs.existsSync(root)) continue;
    const dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isCodexExtension(path.join(root, e.name)))
      .map((e) => path.join(root, e.name));
    dirs.sort((a, b) =>
      path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true }),
    );
    for (const dir of dirs) candidates.push(extensionBinary(dir, platform, arch));
  }
  if (platform === 'darwin')
    candidates.push(
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      path.join(home, '.local', 'bin', 'codex'),
      path.join(home, '.npm-global', 'bin', 'codex'),
    );
  const found = candidates.filter(Boolean).find((file) => isTrustedCodex(file, options));
  if (found) return fs.realpathSync(found);
  if (options.platform === undefined)
    try {
      const file = cp
        .execFileSync(platform === 'win32' ? 'where.exe' : '/usr/bin/which', [name], {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        .trim()
        .split(/\r?\n/)[0];
      if (isTrustedCodex(file, options)) return fs.realpathSync(file);
    } catch {}
  throw Object.assign(
    Error(
      '未找到 Codex 运行程序。请安装 Codex 官方扩展或桌面版；已有安装可在“编辑器与诊断”填写程序路径。',
    ),
    { code: 'CODEX_NOT_FOUND' },
  );
}
module.exports = { findCodex, extensionBinary, isTrustedCodex };
