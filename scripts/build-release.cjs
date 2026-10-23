'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process'),
  crypto = require('node:crypto');
const project = path.resolve(__dirname, '..'),
  target = process.argv[2] || process.platform,
  options = process.argv.slice(3),
  out = path.resolve(
    options.find((value) => !value.startsWith('--')) || path.join(project, 'dist'),
  ),
  macArch = options.find((value) => value.startsWith('--arch='))?.slice(7) || 'universal';
const files = require('../release-files.json'),
  version = require('../package.json').version,
  nodeVersion = 'v22.22.0';
const cache = path.join(project, '.build-cache');
fs.mkdirSync(cache, { recursive: true });
fs.mkdirSync(out, { recursive: true });
async function download(url, file) {
  if (fs.existsSync(file)) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(240000) });
  if (!response.ok) throw Error('Download failed: ' + url + ' HTTP ' + response.status);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}
function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const name = prefix + e.name,
      file = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw Error('Unexpected symlink ' + name);
    return e.isDirectory() ? walk(file, name + '/') : [{ name, file }];
  });
}
function sourceEntries(prefix = '') {
  return files
    .map((name) => ({ name: prefix + name, file: path.join(project, name) }))
    .concat(
      ['smol-toml', 'yaml'].flatMap((dep) =>
        walk(path.join(project, 'node_modules', dep), 'node_modules/' + dep + '/').map((e) => ({
          ...e,
          name: prefix + e.name,
        })),
      ),
    );
}
async function runtime(platform, arch) {
  const name = `node-${nodeVersion}-${platform}-${arch}`,
    ext = platform === 'win' ? 'zip' : 'tar.gz',
    archive = name + '.' + ext,
    file = path.join(cache, archive),
    dir = path.join(cache, name);
  await download(`https://nodejs.org/dist/${nodeVersion}/${archive}`, file);
  const sums = await fetch(`https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`).then((r) => {
    if (!r.ok) throw Error('Checksums unavailable');
    return r.text();
  });
  const expected = sums
    .split('\n')
    .find((l) => l.trim().endsWith('  ' + archive))
    ?.split(/\s+/)[0];
  if (
    !expected ||
    crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected
  )
    throw Error('Runtime checksum mismatch: ' + archive);
  const exe = path.join(dir, platform === 'win' ? 'node.exe' : 'bin/node');
  if (!fs.existsSync(exe))
    cp.execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', file, '-C', cache]);
  return { exe, license: path.join(dir, 'LICENSE') };
}
(async () => {
  let entries, filename;
  if (target === 'win32') {
    const r = await runtime('win', 'x64');
    cp.execFileSync(process.execPath, [path.join(project, 'scripts', 'build-windows-helper.cjs')], {
      stdio: 'inherit',
    });
    entries = sourceEntries('Codex Switcher/');
    entries.push(
      { name: 'Codex Switcher/runtime/node.exe', file: r.exe },
      { name: 'Codex Switcher/runtime/NODE-LICENSE', file: r.license },
      {
        name: 'Codex Switcher/bin/process-context.exe',
        file: path.join(project, 'bin', 'process-context.exe'),
      },
    );
    filename = 'codex-switcher-windows-x64.zip';
  } else if (target === 'darwin') {
    if (process.platform !== 'darwin')
      throw Error('Build the macOS native helper on a macOS host.');
    if (!['arm64', 'x64', 'universal'].includes(macArch))
      throw Error('Unsupported Mac architecture');
    const native = path.join(cache, 'mac-process-context');
    // 固定最低系统版本，避免助手继承构建机的 macOS 26 要求，导致旧系统无法启动。
    cp.execFileSync('clang', [
      '-O2',
      '-Wall',
      '-Wextra',
      '-mmacosx-version-min=12.0',
      '-arch',
      'arm64',
      '-arch',
      'x86_64',
      path.join(project, 'platform/macos/mac-process-context.c'),
      '-o',
      native,
    ]);
    const launcher = path.join(cache, 'mac-launcher');
    cp.execFileSync('clang', [
      '-O2',
      '-Wall',
      '-Wextra',
      '-mmacosx-version-min=12.0',
      '-arch',
      'arm64',
      '-arch',
      'x86_64',
      path.join(project, 'platform/macos/mac-launcher.c'),
      '-o',
      launcher,
    ]);
    const bundle = 'Codex Switcher.app/Contents/',
      resources = bundle + 'Resources/';
    entries = sourceEntries(resources);
    entries.push(
      { name: resources + 'bin/mac-process-context', file: native, mode: 0o100755 },
      {
        name: bundle + 'MacOS/CodexSwitcher',
        file: launcher,
        mode: 0o100755,
      },
      {
        name: 'Install.command',
        file: path.join(project, 'platform/macos/install-mac.command'),
        mode: 0o100755,
      },
    );
    // 按芯片发行时只带一套 Node，避免每个用户下载另一种芯片的运行时。
    for (const arch of macArch === 'universal' ? ['arm64', 'x64'] : [macArch]) {
      const r = await runtime('darwin', arch);
      entries.push(
        { name: resources + `runtime/${arch}/node`, file: r.exe, mode: 0o100755 },
        { name: resources + `runtime/${arch}/NODE-LICENSE`, file: r.license },
      );
    }
    entries.push({
      name: bundle + 'Info.plist',
      data: `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>Codex Switcher</string><key>CFBundleIdentifier</key><string>com.codex-switcher.demo</string><key>CFBundleExecutable</key><string>CodexSwitcher</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>LSMinimumSystemVersion</key><string>12.0</string><key>LSUIElement</key><true/></dict></plist>`,
    });
    filename = `codex-switcher-macos-${macArch}.zip`;
  } else throw Error('Unsupported release target: ' + target);
  const artifact = path.join(out, filename);
  if (target === 'darwin') {
    // 先生成规范的应用目录并签名，再用 macOS 自带 ditto 归档签名和权限。
    // ad-hoc 签名只保证包的完整性，不代表 Apple Developer ID 或公证。
    const stage = fs.mkdtempSync(path.join(cache, 'macos-package-'));
    try {
      for (const entry of entries) {
        const file = path.join(stage, entry.name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (entry.data === undefined) fs.copyFileSync(entry.file, file);
        else fs.writeFileSync(file, entry.data);
        fs.chmodSync(file, (entry.mode || 0o100644) & 0o777);
      }
      const app = path.join(stage, 'Codex Switcher.app');
      cp.execFileSync('/usr/bin/codesign', [
        '--force',
        '--sign',
        '-',
        path.join(app, 'Contents', 'Resources', 'bin', 'mac-process-context'),
      ]);
      cp.execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app]);
      cp.execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
      cp.execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', stage, artifact]);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  } else {
    require('../src/shared/zip.cjs').zip(entries, artifact);
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
  fs.writeFileSync(artifact + '.sha256', digest + '  ' + filename + '\n');
  if (target === 'win32') {
    // 伴随扩展单独提供小体积下载，两种系统都能安装，不必为了更新扩展重下运行时。
    const companion = path.join(out, 'codex-switcher-companion.vsix');
    fs.copyFileSync(require('../src/clients/editor-integration.cjs').build(project), companion);
    const companionHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(companion))
      .digest('hex');
    fs.writeFileSync(companion + '.sha256', companionHash + '  codex-switcher-companion.vsix\n');
  }
  console.log(
    JSON.stringify({
      artifact,
      files: entries.length,
      bytes: fs.statSync(artifact).size,
      sha256: digest,
    }),
  );
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
