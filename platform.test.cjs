'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  cp = require('node:child_process');
test('窗口回报只推进对应重载编号，区分接收、重载和失败', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-ack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clients = require('./client-status.cjs');
  const data = { id: 'old-window-1', pid: 1, home: root };
  clients.heartbeat(root, data);
  const file = path.join(root, 'clients', data.id + '.json');
  const row = JSON.parse(fs.readFileSync(file));
  row.command = { id: 'reload-command-1', type: 'reload' };
  fs.writeFileSync(file, JSON.stringify(row));
  const target = [{ id: data.id, commandId: row.command.id }];
  assert.equal(clients.reloadResults(root, target)[0].status, 'pending');
  clients.heartbeat(root, { ...data, ack: row.command.id, ackStatus: 'reload_requested' });
  assert.equal(clients.reloadResults(root, target)[0].status, 'received');
  clients.heartbeat(root, {
    id: 'new-window-1',
    completedReload: {
      clientId: data.id,
      commandId: 'different-command',
    },
  });
  assert.equal(clients.reloadResults(root, target)[0].status, 'received');
  clients.heartbeat(root, {
    id: 'new-window-1',
    completedReload: {
      clientId: data.id,
      commandId: row.command.id,
    },
  });
  assert.equal(clients.reloadResults(root, target)[0].status, 'reloaded');
  clients.heartbeat(root, {
    ...data,
    ack: row.command.id,
    ackStatus: 'reload_failed',
    ackError: 'fixture failure',
  });
  assert.equal(clients.reloadResults(root, target)[0].status, 'failed');
  assert.equal(clients.reloadResults(root, target)[0].error, 'fixture failure');
  assert.equal(
    clients.reloadResults(root, [{ id: data.id, commandId: 'unrelated' }])[0].status,
    'unconfirmed',
  );
});
test('ZIP packages preserve filenames and executable bits', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-zip-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'test.zip');
  require('./zip.cjs').zip(
    [
      { name: 'Demo.app/Contents/MacOS/start', data: '#!/bin/sh\nexit 0\n', mode: 0o100755 },
      { name: 'extension/package.json', data: '{"name":"test"}' },
    ],
    file,
  );
  cp.execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', file, '-C', root]);
  assert.equal(
    fs.readFileSync(path.join(root, 'extension', 'package.json'), 'utf8'),
    '{"name":"test"}',
  );
  if (process.platform !== 'win32')
    assert.ok(fs.statSync(path.join(root, 'Demo.app/Contents/MacOS/start')).mode & 0o111);
});
test(
  'macOS helper reads actual process home without exposing unrelated environment',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-mac-'));
    const child = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], {
      env: { ...process.env, CODEX_HOME: root, SWITCHER_PRIVATE_SENTINEL: 'must-not-leak' },
      stdio: 'ignore',
    });
    const closed = new Promise((r) => child.once('close', r));
    try {
      const text = cp.execFileSync(
          path.join(__dirname, 'bin/mac-process-context'),
          [String(child.pid)],
          { encoding: 'utf8' },
        ),
        context = JSON.parse(text);
      assert.equal(context.ok, true);
      assert.equal(context.home, root);
      assert.equal(text.includes('must-not-leak'), false);
    } finally {
      child.kill();
      await closed;
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

// 两个平台使用同一场景：不提供 CODEX_EXE、不安装桌面版，
// 从官方扩展的目录结构发现真实 Codex，再验证登录 RPC 与进程归属。
test('native IDE-only runtime starts and cancels official login without a desktop or cached model', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-native-ide-'));
  const { findCodex } = require('./runtime.cjs'),
    native = findCodex();
  const cpu = process.arch === 'arm64' ? 'aarch64' : 'x86_64',
    target = (process.platform === 'darwin' ? 'macos-' : 'windows-') + cpu;
  const exe = path.join(
    root,
    '.vscode',
    'extensions',
    'openai.chatgpt-26.1007.21434',
    'bin',
    target,
    process.platform === 'win32' ? 'codex.exe' : 'codex',
  );
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.copyFileSync(native, exe);
  fs.chmodSync(exe, 0o755);
  const lookup = () =>
    findCodex({
      platform: process.platform,
      arch: process.arch,
      home: root,
      env: {},
      appPaths: [],
      windowsRoot: path.join(root, 'no-desktop'),
    });
  assert.equal(lookup(), fs.realpathSync(exe));
  const codexHome = path.join(root, 'home'),
    bridgeHome = path.join(root, 'bridge');
  fs.mkdirSync(codexHome);
  fs.mkdirSync(bridgeHome);
  const manager = require('./accounts.cjs').createAccounts({
    codexHome,
    bridgeHome,
    codexExe: lookup,
  });
  try {
    const login = await manager.startLogin();
    assert.equal(login.status, 'waiting');
    assert.equal(new URL(login.authUrl).protocol, 'https:');
    if (process.platform === 'darwin') {
      const inventory = require('./mac-processes.cjs').scan(),
        home = path.join(bridgeHome, 'accounts', 'login');
      const processRow = inventory.processes.find(
        (p) => p.context.ok && require('./client-status.cjs').sameHome(p.context.home, home),
      );
      assert.ok(processRow, 'native Codex process must be discovered with its actual CODEX_HOME');
      assert.equal(require('./client-status.cjs').sameHome(processRow.context.cwd, home), true);
    }
    await manager.cancelLogin();
    assert.equal(manager.status().login.status, 'cancelled');
    assert.equal(manager.status().items.length, 0);
    assert.equal(fs.existsSync(path.join(codexHome, 'config.toml')), false);
    assert.equal(fs.existsSync(path.join(codexHome, 'auth.json')), false);
  } finally {
    await manager.cancelLogin();
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
