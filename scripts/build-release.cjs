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
  macArch =
    options.find((value) => value.startsWith('--arch='))?.slice(7) ||
    process.arch;
const binaryDir = process.env.SWITCHER_RUST_BIN_DIR || path.join(project, 'rust/target/release');
const version = require('../package.json').version;
const sequence = Number(process.env.GITHUB_RUN_NUMBER);
if (!Number.isSafeInteger(sequence) || sequence <= 0)
  throw Error('GITHUB_RUN_NUMBER 必须为正整数，用作发行序号。');
const cache = path.join(project, '.build-cache');
fs.mkdirSync(cache, { recursive: true });
fs.mkdirSync(out, { recursive: true });
(async () => {
  let entries, filename;
  if (target === 'win32') {
    entries = require('./rust-release.cjs').entries(
      'Codex Switcher/', sequence, target, 'x64', binaryDir,
    );
    filename = 'codex-switcher-windows-x64.zip';
  } else if (target === 'darwin') {
    if (process.platform !== 'darwin')
      throw Error('Build the macOS native helper on a macOS host.');
    if (!['arm64', 'x64', 'universal'].includes(macArch))
      throw Error('Unsupported Mac architecture');
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
    entries = require('./rust-release.cjs').entries(resources, sequence, target, macArch, binaryDir);
    entries.push(
      { name: resources + 'AppIcon.icns', file: path.join(project, 'platform/macos/AppIcon.icns') },
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
    entries.push({
      name: bundle + 'Info.plist',
      data: `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>Codex Switcher</string><key>CFBundleIdentifier</key><string>com.codex-switcher.demo</string><key>CFBundleExecutable</key><string>CodexSwitcher</string><key>CFBundleIconFile</key><string>AppIcon</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>LSMinimumSystemVersion</key><string>12.0</string><key>LSUIElement</key><true/></dict></plist>`,
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
        '--force', '--sign', '-', path.join(app, 'Contents/Resources/codex-switcher'),
      ]);
      cp.execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app]);
      cp.execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
      cp.execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', stage, artifact]);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  } else {
    require('./lib/zip.cjs').zip(entries, artifact);
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
  fs.writeFileSync(artifact + '.sha256', digest + '  ' + filename + '\n');
  if (target === 'win32') {
    // 两份扩展均为跨平台小包；由Windows任务提供独立下载，所有平台包都带可离线构建的源码。
    const integration = require('./lib/vsix.cjs');
    for (const [name, build] of [
      ['codex-switcher-companion.vsix', integration.build],
      ['codex-switcher-remote.vsix', integration.buildRemote],
    ]) {
      const file = path.join(out, name);
      fs.copyFileSync(build(project), file);
      const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      fs.writeFileSync(file + '.sha256', hash + '  ' + name + '\n');
    }
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
