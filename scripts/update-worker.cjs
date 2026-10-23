'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const pid = Number(args.get('--pid')),
  archive = args.get('--archive'),
  target = args.get('--target');
if (!pid || !archive || !target) throw Error('升级参数不完整');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  for (let i = 0; i < 30; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    await sleep(1000);
  }
  // 仅支持发行包的固定目录覆盖；release-files.json 是唯一允许替换的清单。
  const staging = fs.mkdtempSync(path.join(path.dirname(archive), 'extracted-'));
  if (process.platform === 'win32')
    cp.execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${staging.replace(/'/g, "''")}' -Force`,
      ],
      { windowsHide: true },
    );
  else cp.execFileSync('/usr/bin/ditto', ['-x', '-k', archive, staging]);
  const root = path.join(
    staging,
    process.platform === 'win32' ? 'Codex Switcher' : 'Codex Switcher.app',
    process.platform === 'win32' ? '' : 'Contents/Resources',
  );
  const files = JSON.parse(fs.readFileSync(path.join(root, 'release-files.json'), 'utf8'));
  for (const relative of files) {
    const source = path.join(root, relative),
      destination = path.join(target, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  cp.spawn(process.execPath, [path.join(target, 'main.cjs')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
})().catch((error) => {
  fs.appendFileSync(
    path.join(path.dirname(archive), 'update-error.log'),
    new Date().toISOString() + ' ' + error.message + '\n',
  );
  process.exitCode = 1;
});
