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
// The two small legacy markers/directories are required by the published seq136
// updater. Its own Node VM reads build-info.cjs, then launches our native bridge.
function entries(prefix, sequence, target, arch, binaryDir) {
  const build = require('./rust-build-info.cjs').buildInfo(sequence);
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
        'install.ps1',
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
  const bridge = target === 'win32' ? 'upgrade-bridge.exe' : 'upgrade-bridge';
  const files = [
    ...names,
    native,
    'main.cjs',
    'scripts/update-worker.cjs',
    'src/platform/build-info.cjs',
    'src/platform/release-info.json',
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
        name: prefix + 'main.cjs',
        data: '// Native release. The seq136 updater uses runtime/node to launch codex-switcher.\n',
      },
      {
        name: prefix + 'scripts/update-worker.cjs',
        data: '// Native upgrade bridge dispatches this legacy entry to --update-worker.\n',
      },
      {
        name: prefix + 'src/platform/build-info.cjs',
        data: `'use strict'; module.exports={buildInfo:()=>(${JSON.stringify(build)})};\n`,
      },
      {
        name: prefix + 'src/platform/release-info.json',
        data: JSON.stringify({ sequence }) + '\n',
      },
      { name: prefix + 'release-files.json', data: JSON.stringify(files, null, 2) + '\n' },
      {
        name: prefix + (target === 'win32' ? 'runtime/node.exe' : `runtime/${arch}/node`),
        file: path.join(binaryDir, bridge),
        mode: 0o100755,
      },
      { name: prefix + 'bin/.keep', data: '' },
      { name: prefix + 'node_modules/.keep', data: '' },
    ]);
}
module.exports = { entries };
