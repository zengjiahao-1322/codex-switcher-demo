'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const net = require('node:net');
const assert = require('node:assert/strict');
const { findCodex } = require('../runtime.cjs');

// 通过 LaunchServices 打开打包后的 .app，覆盖 Finder 双击所用的系统启动入口。
// 用 --env 指定独立 HOME，避免测试写入运行机的默认账号和配置。
const project = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-mac-launcher-'));
const reportFile = path.join(project, 'verification', 'macos-launcher.json');
const report = { platform: process.platform, arch: process.arch };
let servicePid;
let runningFile;
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));

(async () => {
  try {
    assert.equal(process.platform, 'darwin');
    cp.execFileSync('/usr/bin/ditto', [
      '-xk',
      path.join(
        project,
        'dist',
        fs.existsSync(path.join(project, 'dist', `codex-switcher-macos-${process.arch}.zip`))
          ? `codex-switcher-macos-${process.arch}.zip`
          : 'codex-switcher-macos-universal.zip',
      ),
      root,
    ]);
    const home = path.join(root, 'isolated-home');
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const config = 'model="finder-model"\n';
    fs.writeFileSync(path.join(codexHome, 'config.toml'), config);
    const cpu = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const executable = path.join(
      home,
      '.vscode',
      'extensions',
      'openai.chatgpt-fixture',
      'bin',
      `macos-${cpu}`,
      'codex',
    );
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync(findCodex(), executable);
    fs.chmodSync(executable, 0o755);
    const port = await new Promise((resolve) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const value = server.address().port;
        server.close(() => resolve(value));
      });
    });
    const app = path.join(root, 'Codex Switcher.app');
    cp.execFileSync(
      '/usr/bin/open',
      [
        '-n',
        '-g',
        '--env',
        'HOME=' + home,
        '--env',
        'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
        '--env',
        'BRIDGE_PORT=' + port,
        '-a',
        app,
        '--args',
        '--no-open',
      ],
      {
        env: {
          HOME: home,
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          LANG: 'en_US.UTF-8',
          TMPDIR: os.tmpdir(),
          BRIDGE_PORT: String(port),
        },
        timeout: 10000,
      },
    );
    runningFile = path.join(
      home,
      'Library',
      'Application Support',
      'CodexApiSwitcher',
      'running.json',
    );
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(runningFile) && Date.now() < deadline) await pause();
    assert.ok(fs.existsSync(runningFile), '.app 入口必须启动服务');
    const running = JSON.parse(fs.readFileSync(runningFile, 'utf8'));
    servicePid = running.pid;
    const url = new URL(running.url);
    const headers = {
      Authorization: 'Bearer ' + url.hash.slice(1),
      'Content-Type': 'application/json',
    };
    const response = await fetch(url.origin + '/api/state', { headers });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.current.model, 'finder-model');
    assert.equal(state.codexFound, true, '应发现唯一安装的官方插件运行程序');
    const clients = await fetch(url.origin + '/api/clients', {
      method: 'POST',
      headers,
      body: '{}',
    }).then((value) => value.json());
    assert.equal(fs.realpathSync(clients.home), fs.realpathSync(codexHome));
    assert.equal(fs.realpathSync(clients.runtime), fs.realpathSync(executable));
    assert.equal(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), config);
    report.passed = true;
    report.checks = [
      'packaged-app-entry',
      'LaunchServices-open',
      'minimal-Finder-like-environment',
      'IDE-only-runtime-discovery',
      'default-configuration-read',
      'client-status',
    ];
  } catch (error) {
    report.passed = false;
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    if (servicePid) {
      process.kill(servicePid, 'SIGTERM');
      const deadline = Date.now() + 10000;
      while (fs.existsSync(runningFile) && Date.now() < deadline) await pause();
      assert.equal(fs.existsSync(runningFile), false, '测试服务必须退出并清理运行记录');
    }
    report.checkedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  console.log(JSON.stringify(report));
})();
