'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  cp = require('node:child_process'),
  net = require('node:net'),
  assert = require('node:assert/strict');
const target = process.argv[2] || process.platform,
  archive = path.resolve(
    'dist',
    target === 'darwin' ? 'codex-switcher-macos-universal.zip' : 'codex-switcher-windows-x64.zip',
  );
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-package-'));
let child, closed;
const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
(async () => {
  try {
    if (target === 'darwin') cp.execFileSync('/usr/bin/ditto', ['-xk', archive, root]);
    else {
      const env = { ...process.env, SWITCHER_SMOKE_ZIP: archive, SWITCHER_SMOKE_ROOT: root };
      delete env.PSModulePath;
      cp.execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Expand-Archive -LiteralPath $env:SWITCHER_SMOKE_ZIP -DestinationPath $env:SWITCHER_SMOKE_ROOT',
        ],
        { env, windowsHide: true },
      );
    }
    const app =
        target === 'darwin'
          ? path.join(root, 'Codex Switcher.app', 'Contents', 'Resources')
          : path.join(root, 'Codex Switcher'),
      node =
        target === 'darwin'
          ? path.join(app, 'runtime', process.arch, 'node')
          : path.join(app, 'runtime', 'node.exe'),
      home = path.join(root, 'home'),
      bridge = path.join(root, 'private');
    fs.mkdirSync(home);
    fs.mkdirSync(bridge);
    fs.writeFileSync(path.join(home, 'config.toml'), 'model="package-smoke"\n');
    const env = {
      ...process.env,
      BRIDGE_HOME: bridge,
      BRIDGE_CODEX_HOME: home,
      BRIDGE_HERMES_HOME: path.join(root, 'no-hermes'),
      BRIDGE_DISCOVERY_DIR: path.join(root, 'discovery'),
      BRIDGE_PORT: String(await freePort()),
    };
    child = cp.spawn(node, [path.join(app, 'main.cjs'), '--no-open'], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    closed = new Promise((r) => child.once('close', r));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Packaged service did not start')), 20000);
      let text = '';
      child.stdout.on('data', (chunk) => {
        text += chunk;
        if (text.includes('BRIDGE_READY')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(Error('Packaged service exited ' + code));
      });
    });
    const u = new URL(JSON.parse(fs.readFileSync(path.join(bridge, 'running.json'))).url),
      api = async (name) => {
        const response = await fetch(u.origin + '/api/' + name, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + u.hash.slice(1),
            'Content-Type': 'application/json',
          },
          body: '{}',
        });
        const value = await response.json();
        assert.equal(response.status, 200, JSON.stringify(value));
        return value;
      };
    assert.equal((await fetch(u.origin + '/')).status, 200);
    assert.equal((await api('accounts')).items.length, 0);
    await api('clients');
    const vsix = await api('companionPackage');
    const response = await fetch(u.origin + vsix.url);
    assert.equal(response.status, 200);
    assert.ok((await response.arrayBuffer()).byteLength > 1000);
    assert.equal(
      fs.readFileSync(path.join(home, 'config.toml'), 'utf8'),
      'model="package-smoke"\n',
    );
    if (target === 'win32') {
      const installed = path.join(root, 'installed');
      cp.execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(app, 'install.ps1'),
          '-InstallDir',
          installed,
          '-NoLaunch',
          '-NoShortcuts',
        ],
        { env, stdio: 'pipe', windowsHide: true, timeout: 60000 },
      );
      for (const file of [
        'platform.cjs',
        'process-context.ps1',
        'diagnostics.cjs',
        'editor-integration.cjs',
        'vscode-companion/extension.cjs',
        'node_modules/smol-toml/package.json',
      ])
        assert.ok(
          fs.existsSync(path.join(installed, file)),
          file + ' missing after offline install',
        );
      assert.match(
        cp.execFileSync(path.join(installed, 'runtime', 'node.exe'), ['--version'], {
          encoding: 'utf8',
        }),
        /^v22\./,
      );
    }
    if (target === 'darwin') {
      cp.execFileSync('/usr/bin/plutil', ['-lint', path.resolve(app, '..', 'Info.plist')]);
      cp.execFileSync('/usr/bin/lipo', [
        path.join(app, 'bin', 'mac-process-context'),
        '-verify_arch',
        'arm64',
        'x86_64',
      ]);
      // 应用的 LSMinimumSystemVersion 与内置助手必须一致，不能只验证文件存在和可执行位。
      const buildInfo = cp.execFileSync(
        '/usr/bin/vtool',
        ['-show-build', path.join(app, 'bin', 'mac-process-context')],
        { encoding: 'utf8' },
      );
      const minimumVersions = [...buildInfo.matchAll(/\bminos\s+([\d.]+)/g)].map(
        (match) => match[1],
      );
      assert.equal(minimumVersions.length, 2, '两个架构都必须包含最低版本标记');
      assert.ok(
        minimumVersions.every((version) => /^12\.0(?:\.0)?$/.test(version)),
        '原生助手最低版本必须为 macOS 12.0',
      );
      for (const arch of ['arm64', 'x64'])
        assert.ok(fs.statSync(path.join(app, 'runtime', arch, 'node')).mode & 0o111);
      fs.mkdirSync(path.resolve('verification'), { recursive: true });
      fs.writeFileSync(
        path.resolve('verification', 'macos-package.json'),
        JSON.stringify(
          {
            passed: true,
            arch: process.arch,
            minimumMacOS: minimumVersions,
            universalHelper: true,
          },
          null,
          2,
        ),
      );
    }
    console.log(
      'PASS extracted ' +
        target +
        ' package: service, UI, clients, empty account store, VSIX download, config preserved',
    );
  } finally {
    if (child) {
      child.kill();
      await closed;
    }
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
