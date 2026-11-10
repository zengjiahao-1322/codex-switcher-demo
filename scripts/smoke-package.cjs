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
    target === 'darwin'
      ? fs.existsSync(path.resolve('dist', `codex-switcher-macos-${process.arch}.zip`))
        ? `codex-switcher-macos-${process.arch}.zip`
        : 'codex-switcher-macos-universal.zip'
      : 'codex-switcher-windows-x64.zip',
  );
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-package-'));
let child, closed, servicePid;
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
      home = path.join(root, 'home'),
      bridge = path.join(root, 'private');
    const native = path.join(app, target === 'win32' ? 'codex-switcher.exe' : 'codex-switcher');
    assert.ok(fs.existsSync(native), 'Native release executable missing');
    // 同一份源码的所有发行包和 release.json 必须使用同一个构建号。
    const packagedBuild = JSON.parse(
      cp.execFileSync(native, ['--build-info'], { cwd: app, encoding: 'utf8' }).trim(),
    );
    assert.deepEqual(
      packagedBuild,
      require('./rust-build-info.cjs').buildInfo(Number(process.env.GITHUB_RUN_NUMBER)),
      '发行包构建号与源码不一致',
    );
    // 页面的每个文件都要进包：漏掉一个模块，整页都打不开，而 release-files.json 要手动登记新文件。
    const webFiles = fs
      .readdirSync('web', { recursive: true })
      .filter((file) => fs.statSync(path.join('web', file)).isFile());
    assert.deepEqual(
      webFiles.filter((file) => !fs.existsSync(path.join(app, 'web', file))),
      [],
      '发行包缺少页面文件，请登记到 release-files.json',
    );
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
      SWITCHER_TEST_SHELL_ROOT: path.join(root, 'shell'),
    };
    for (const directory of ['runtime', 'bin', 'node_modules'])
      assert.ok(fs.existsSync(path.join(app, directory, '.keep')), directory + '/.keep missing');
    assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'release-info.json'))).sequence, packagedBuild.sequence);
    for (const obsolete of ['main.cjs', 'scripts/update-worker.cjs', 'src/platform/build-info.cjs'])
      assert.equal(fs.existsSync(path.join(app, obsolete)), false, obsolete + ' must not be packaged');
    child = cp.spawn(native, ['--no-open'], {
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
        if (text.includes('BRIDGE_READY') || text.includes('"event":"ready"')) {
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
      api = async (name, input = {}) => {
        const response = await fetch(u.origin + '/api/' + name, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + u.hash.slice(1),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(input),
        });
        const value = await response.json();
        assert.equal(response.status, 200, JSON.stringify(value));
        return value;
      };
    servicePid = JSON.parse(fs.readFileSync(path.join(bridge, 'running.json'))).pid;
    assert.equal((await fetch(u.origin + '/')).status, 200);
    assert.equal((await api('accounts')).items.length, 0);
    await api('clients');
    // 从解压后的发行包调用心跳，确认未依赖开发目录，也不会把连通误报为已接入。
    const heartbeat = await api('clientHeartbeat', {
      id: 'package-smoke-window',
      pid: child.pid,
      name: 'Package smoke',
      home,
    });
    assert.equal(heartbeat.connection.state, 'unmatched');
    assert.equal(heartbeat.connection.home, home);
    assert.deepEqual(heartbeat.connection.backendPids, []);
    const vsix = await api('companionPackage');
    const response = await fetch(u.origin + vsix.url);
    assert.equal(response.status, 200);
    assert.ok((await response.arrayBuffer()).byteLength > 1000);
    const remoteVsix = await api('remoteAgentPackage'),
      remoteResponse = await fetch(u.origin + remoteVsix.url);
    assert.equal(remoteVsix.filename, 'codex-switcher-remote.vsix');
    assert.equal(remoteResponse.status, 200);
    assert.match(remoteResponse.headers.get('content-disposition'), /codex-switcher-remote\.vsix/);
    assert.ok((await remoteResponse.arrayBuffer()).byteLength > 1000);
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
          path.join(app, 'platform/windows/install.ps1'),
          '-InstallDir',
          installed,
          '-NoLaunch',
          '-NoShortcuts',
        ],
        { env, stdio: 'pipe', windowsHide: true, timeout: 60000 },
      );
      for (const file of [
        'codex-switcher.exe', 'web/index.html',
        'vscode-companion/extension.cjs', 'vscode-remote-agent/extension.cjs',
      ]) assert.ok(fs.existsSync(path.join(installed, file)), file + ' missing after offline install');
      assert.equal(
        JSON.parse(cp.execFileSync(path.join(installed, 'codex-switcher.exe'), ['--build-info'], {
          encoding: 'utf8',
        })).id,
        packagedBuild.id,
      );
    }
    if (target === 'darwin') {
      cp.execFileSync('/usr/bin/plutil', ['-lint', path.resolve(app, '..', 'Info.plist')]);
      fs.mkdirSync(path.resolve('verification'), { recursive: true });
      fs.writeFileSync(
        path.resolve('verification', 'macos-package.json'),
        JSON.stringify(
          {
            passed: true,
            arch: process.arch,
          },
          null,
          2,
        ),
      );
    }
    console.log(
      'PASS extracted ' +
        target +
        ' package: service, UI, clients, heartbeat linkage, empty account store, VSIX download, config preserved',
    );
  } finally {
    if (child) {
      if (servicePid && servicePid !== child.pid) {
        try {
          process.kill(servicePid);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      child.kill();
      await closed;
    }
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
