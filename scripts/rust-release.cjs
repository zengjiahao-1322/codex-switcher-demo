'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process');
const project = path.resolve(__dirname, '..');
// The Windows toolchain has no resource compiler, so the icon is written after linking.
function stamped(binaryDir, native) {
  const file = path.join(project, '.build-cache/stamped', native);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(path.join(binaryDir, native), file);
  cp.execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(project, 'scripts/stamp-windows-icon.ps1'),
      '-Exe',
      file,
      '-Icon',
      path.join(project, 'platform/windows/app.ico'),
    ],
    { stdio: 'inherit' },
  );
  return file;
}
function entries(prefix, sequence, target, arch, binaryDir) {
  const names = require('../release-files.json').filter(
    (name) =>
      /^(web|vscode-companion|vscode-remote-agent|data)\//.test(name) ||
      [
        'LICENSE',
        'README.md',
        'CHANGELOG.md',
        'docs/ARCHITECTURE.md',
        'package.json',
        'install.cmd',
        'Start.cmd',
        'launch-hidden.vbs',
        'uninstall.ps1',
        'platform/windows/install.ps1',
        'platform/windows/uninstall.ps1',
        'platform/windows/desktop-integration.ps1',
        'platform/macos/install-mac.command',
        'platform/macos/mac-launcher.sh',
        'platform/macos/uninstall-mac.sh',
      ].includes(name),
  );
  const native = target === 'win32' ? 'codex-switcher.exe' : 'codex-switcher';
  const files = [
    ...names,
    native,
    'release-info.json',
    'release-files.json',
  ];
  return names
    .map((name) => ({ name: prefix + name, file: path.join(project, name) }))
    .concat([
      {
        name: prefix + native,
        file: target === 'win32' ? stamped(binaryDir, native) : path.join(binaryDir, native),
        mode: 0o100755,
      },
      {
        name: prefix + 'release-info.json',
        data: JSON.stringify({ sequence }) + '\n',
      },
      { name: prefix + 'release-files.json', data: JSON.stringify(files, null, 2) + '\n' },
      // All seven published Rust updaters require these directories, without a Node runtime.
      // update.rs: v0.1.6-rc.1/2:408; rc.3:434; rc.4:435;
      // v0.1.7-rc.1/2:652; rc.3:657. See collab/cleanup-r1-report.md section 1.
      { name: prefix + 'runtime/.keep', data: '' },
      { name: prefix + 'bin/.keep', data: '' },
      { name: prefix + 'node_modules/.keep', data: '' },
    ]);
}
module.exports = { entries };
