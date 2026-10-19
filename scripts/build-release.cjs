'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process'),
  crypto = require('node:crypto');
const project = path.resolve(__dirname, '..'),
  target = process.argv[2] || process.platform,
  out = path.resolve(process.argv[3] || path.join(project, 'dist'));
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
    entries = sourceEntries('Codex Switcher/');
    entries.push(
      { name: 'Codex Switcher/release-files.json', file: path.join(project, 'release-files.json') },
      { name: 'Codex Switcher/runtime/node.exe', file: r.exe },
      { name: 'Codex Switcher/runtime/NODE-LICENSE', file: r.license },
    );
    filename = 'codex-switcher-windows-x64.zip';
  } else if (target === 'darwin') {
    if (process.platform !== 'darwin')
      throw Error('Build the macOS native helper on a macOS host.');
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
      path.join(project, 'mac-process-context.c'),
      '-o',
      native,
    ]);
    const bundle = 'Codex Switcher.app/Contents/',
      resources = bundle + 'Resources/';
    entries = sourceEntries(resources);
    entries.push(
      { name: resources + 'bin/mac-process-context', file: native, mode: 0o100755 },
      {
        name: bundle + 'MacOS/CodexSwitcher',
        file: path.join(project, 'mac-launcher.sh'),
        mode: 0o100755,
      },
      { name: 'Install.command', file: path.join(project, 'install-mac.command'), mode: 0o100755 },
    );
    for (const arch of ['arm64', 'x64']) {
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
    filename = 'codex-switcher-macos-universal.zip';
  } else throw Error('Unsupported release target: ' + target);
  const artifact = path.join(out, filename);
  require('../zip.cjs').zip(entries, artifact);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
  fs.writeFileSync(artifact + '.sha256', digest + '  ' + filename + '\n');
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
