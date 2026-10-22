'use strict';
const { PROJECT_ROOT } = require('../src/paths.cjs');

const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  cp = require('node:child_process');
test('Windows 手动系统代理支持统一地址、按协议地址和关闭状态', () => {
  const { windowsProxyEnv } = require('../src/platform/platform.cjs');
  assert.deepEqual(windowsProxyEnv({ enabled: 0, server: '127.0.0.1:7897' }), {});
  assert.deepEqual(windowsProxyEnv({ enabled: 1, server: '127.0.0.1:7897' }), {
    HTTP_PROXY: 'http://127.0.0.1:7897',
    HTTPS_PROXY: 'http://127.0.0.1:7897',
  });
  assert.deepEqual(
    windowsProxyEnv({ enabled: 1, server: 'http=host:80;https=host:81;socks=host:82' }),
    {
      HTTP_PROXY: 'http://host:80',
      HTTPS_PROXY: 'http://host:81',
      ALL_PROXY: 'socks5h://host:82',
    },
  );
});
test('显式代理环境变量优先，不读取 Windows 系统代理', (t) => {
  const previous = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://explicit-proxy.example:1234';
  try {
    const read = t.mock.method(cp, 'execFileSync', () => {
      throw Error('不应读取系统代理');
    });
    const env = require('../src/platform/platform.cjs').codexEnv('fixture-home');
    assert.equal(env.HTTPS_PROXY, process.env.HTTPS_PROXY);
    assert.equal(read.mock.callCount(), 0);
  } finally {
    if (previous === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previous;
  }
});

test('Win/Mac 伴随扩展按后端关联显示状态，远程窗口标记不阻止已确认的本机重载', async (t) => {
  const http = require('node:http'),
    vm = require('node:vm');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-companion-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const platform of ['win32', 'darwin']) {
    let state = 'unmatched',
      command = null,
      didReload;
    const reload = new Promise((resolve) => {
      didReload = resolve;
    });
    const requests = [],
      subscriptions = [],
      commands = new Map(),
      saved = new Map();
    const server = http.createServer(async (req, res) => {
      let data = '';
      for await (const chunk of req) data += chunk;
      requests.push(JSON.parse(data));
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          command,
          connection: { state, home: root, backendPids: state === 'ready' ? [811] : [] },
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const file = path.join(root, platform + '.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port + '/#fixture' }),
    );
    const status = { show() {}, dispose() {} };
    const vscode = {
      StatusBarAlignment: { Right: 1 },
      window: { createStatusBarItem: () => status },
      env: { appName: 'VS Code', remoteName: 'ssh-remote' },
      extensions: { all: [] },
      workspace: {
        workspaceFolders: [],
        getConfiguration: (name) => ({
          get: (key, fallback) =>
            name === 'codexSwitcher'
              ? file
              : key === 'runCodexInWindowsSubsystemForLinux'
                ? true
                : fallback,
        }),
      },
      commands: {
        registerCommand: (name, action) => {
          commands.set(name, action);
          return { dispose() {} };
        },
        executeCommand: async (name) => {
          assert.equal(name, 'workbench.action.reloadWindow');
          didReload();
        },
      },
    };
    const loaded = { exports: {} };
    const nativeRequire = require('node:module').createRequire(
      path.join(PROJECT_ROOT, 'vscode-companion', 'extension.cjs'),
    );
    vm.runInNewContext(
      fs.readFileSync(path.join(PROJECT_ROOT, 'vscode-companion', 'extension.cjs'), 'utf8'),
      {
        require: (name) => (name === 'vscode' ? vscode : nativeRequire(name)),
        exports: loaded.exports,
        process: { platform, arch: 'x64', pid: 810, env: {} },
        URL,
        setInterval: () => 1,
        clearInterval() {},
        setTimeout,
      },
    );
    try {
      loaded.exports.activate({
        subscriptions,
        workspaceState: {
          get: (key) => saved.get(key),
          update: async (key, value) => saved.set(key, value),
        },
      });
      const until = Date.now() + 3000;
      while (!status.text.includes('后端未关联') && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.match(status.text, /后端未关联/);
      assert.equal(requests[0].wsl, platform === 'win32');
      state = 'ready';
      command = { id: 'confirmed-local-reload', type: 'reload' };
      await commands.get('codexSwitcher.connect')();
      assert.match(status.text, /已接入/);
      assert.match(status.tooltip, /811/);
      await Promise.race([
        reload,
        new Promise((_, reject) => setTimeout(() => reject(Error('未执行本机重载')), 3000)),
      ]);
      assert.ok(requests.some((r) => r.ackStatus === 'reload_requested'));
      state = 'separate';
      command = null;
      await commands.get('codexSwitcher.connect')();
      assert.match(status.text, /独立配置/);
    } finally {
      subscriptions.forEach((s) => s.dispose());
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
test('窗口回报只推进对应重载编号，区分接收、重载和失败', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-ack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clients = require('../src/clients/client-status.cjs');
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
  require('../src/shared/zip.cjs').zip(
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
  'Windows 未运行目标桌面时跳过退出等待，不向空 PID 查询进程',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-no-desktop-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const missing = path.join(root, 'nonexistent-desktop.exe');
    assert.equal(fs.existsSync(missing), false);
    await require('../src/clients/desktop-account.cjs').stopDesktop(missing);
  },
);

test(
  'Windows 关闭共享桌面后确认真实退出，保留同路径的独立配置实例',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-stop-'));
    const app = path.join(root, 'OpenAI.Codex_test', 'app'),
      home = path.join(root, 'shared');
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(home);
    const exe = path.join(app, 'Codex.exe');
    fs.copyFileSync(process.execPath, exe);
    const children = [home, path.join(root, 'independent')].map((codexHome) => {
      const child = cp.spawn(exe, ['-e', 'setTimeout(()=>{},60000)'], {
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: 'ignore',
        windowsHide: true,
      });
      return { child, closed: new Promise((resolve) => child.once('close', resolve)) };
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      let ticks = 0;
      const timer = setInterval(() => ticks++, 50);
      try {
        await require('../src/clients/desktop-account.cjs').stopDesktop(exe, home);
      } finally {
        clearInterval(timer);
      }
      // 真实 PowerShell 关闭进程期间，心跳和另一个释放操作仍可执行。
      assert.ok(ticks > 1);
      await children[0].closed;
      assert.notEqual(children[0].child.exitCode, null);
      assert.doesNotThrow(() => process.kill(children[1].child.pid, 0));
    } finally {
      for (const { child } of children) child.kill();
      await Promise.all(children.map(({ closed }) => closed));
      assert.equal(path.dirname(root), os.tmpdir());
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  'Windows 桌面可执行文件名为 Codex.exe 时不把渲染子进程当成另一客户端',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-shell-'));
    const app = path.join(root, 'OpenAI.Codex_test', 'app');
    fs.mkdirSync(app, { recursive: true });
    const exe = path.join(app, 'Codex.exe');
    fs.copyFileSync(process.execPath, exe);
    const marker = path.join(root, 'renderer.pid');
    const code =
      "const fs=require('fs'),cp=require('child_process');const p=cp.spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(process.argv[1],String(p.pid));setTimeout(()=>{},30000);";
    const shell = cp.spawn(exe, ['-e', code, marker], {
      env: { ...process.env, CODEX_HOME: root },
      stdio: 'ignore',
      windowsHide: true,
    });
    const closed = new Promise((resolve) => shell.once('close', resolve));
    let renderer;
    try {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(marker) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      renderer = Number(fs.readFileSync(marker, 'utf8'));
      const rows = require('../src/clients/client-status.cjs')
        .scan({ force: true })
        .processes.filter((p) => [shell.pid, renderer].includes(p.pid));
      assert.deepEqual(
        rows.map((p) => p.pid),
        [shell.pid],
      );
      assert.equal(rows[0].context.ok, true);
      const asynchronous = (
        await require('../src/clients/client-status.cjs').scanAsync({ force: true })
      ).processes.filter((p) => [shell.pid, renderer].includes(p.pid));
      assert.deepEqual(
        asynchronous.map((p) => p.pid),
        [shell.pid],
      );
      assert.equal(asynchronous[0].context.home, rows[0].context.home);
    } finally {
      if (renderer) {
        try {
          process.kill(renderer);
        } catch {}
      }
      shell.kill();
      await closed;
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
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
          path.join(PROJECT_ROOT, 'bin/mac-process-context'),
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

test('两端都停止共享插件后端并保留独立配置，Mac 后端忽略退出信号时仍能继续重载', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-editor-stop-'));
  const home = path.join(root, 'shared'),
    separate = path.join(root, 'independent'),
    bridge = path.join(root, 'bridge'),
    exe = path.join(
      root,
      'openai.chatgpt-fixture',
      'bin',
      process.platform === 'win32' ? 'codex.exe' : 'codex',
    );
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.mkdirSync(home);
  fs.mkdirSync(separate);
  fs.mkdirSync(bridge);
  fs.copyFileSync(process.execPath, exe);
  fs.chmodSync(exe, 0o755);
  const children = [home, home, separate].map((codexHome) => {
    const child = cp.spawn(
      exe,
      ['-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
      {
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    );
    return {
      child,
      ready: new Promise((resolve, reject) => {
        child.stdout.once('data', resolve);
        child.once('error', reject);
      }),
      closed: new Promise((resolve) => child.once('close', resolve)),
    };
  });
  try {
    await Promise.all(children.map((entry) => entry.ready));
    const clients = require('../src/clients/client-status.cjs');
    clients.heartbeat(bridge, {
      id: 'fixture-host-1',
      pid: process.pid,
      name: 'Fixture editor',
      home,
    });
    const before = clients.snapshot(home, bridge, { inventory: clients.scan({ force: true }) });
    for (let index = 0; index < children.length; index++) {
      const row = before.clients.find((client) => client.pid === children[index].child.pid);
      assert.ok(row, '必须读取到原生进程');
      assert.equal(row.confirmed, true);
      assert.equal(row.kind, 'ide');
      assert.equal(row.shared, index < 2);
    }
    const stopped = await clients.stopEditorBackends(home, bridge);
    await Promise.all(children.slice(0, 2).map((entry) => entry.closed));
    if (process.platform === 'darwin')
      assert.ok(children.slice(0, 2).every(({ child }) => child.signalCode === 'SIGKILL'));
    assert.doesNotThrow(() => process.kill(children[2].child.pid, 0));
    assert.equal(stopped.length, 1);
    // 刷新进程表后旧后端已经消失，原窗口仍必须收到重载命令。
    clients.scan({ force: true });
    const request = clients.requestReload(home, bridge, { stoppedEditors: stopped });
    assert.equal(request.count, 1);
    assert.equal(
      clients.heartbeat(bridge, { id: 'fixture-host-1', pid: process.pid }).command.id,
      request.targets[0].commandId,
    );
  } finally {
    for (const { child } of children) child.kill('SIGKILL');
    await Promise.all(children.map((entry) => entry.closed));
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('进程检查权限错误不能被当作已退出并继续切换', async (t) => {
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, 123456789);
    if (signal === 0) throw Object.assign(Error('fixture denied'), { code: 'EPERM' });
  });
  await assert.rejects(require('../src/platform/process-stop.cjs').stopProcesses([123456789]), {
    code: 'EPERM',
  });
});

// 两个平台使用同一场景：不提供 CODEX_EXE、不安装桌面版，
// 从官方扩展的目录结构发现真实 Codex，再验证登录 RPC 与进程归属。
test('native IDE-only runtime starts and cancels official login without a desktop or cached model', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-native-ide-'));
  const { findCodex } = require('../src/platform/runtime.cjs'),
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
  let loginHome;
  const manager = require('../src/accounts/accounts.cjs').createAccounts({
    codexHome,
    bridgeHome,
    codexExe: lookup,
    spawnProcess: (exe, args, options) => {
      loginHome = options.env.CODEX_HOME;
      return cp.spawn(exe, args, options);
    },
  });
  try {
    const login = await manager.startLogin();
    assert.equal(login.status, 'waiting');
    assert.equal(new URL(login.authUrl).protocol, 'https:');
    // 登录已按尝试隔离目录；验证实际传入子进程的目录，而非旧的共享路径。
    const loginRoot = path.join(bridgeHome, 'accounts', 'login');
    assert.equal(
      require('../src/clients/client-status.cjs').sameHome(path.dirname(loginHome), loginRoot),
      true,
    );
    assert.equal(fs.existsSync(path.join(loginHome, 'config.toml')), true);
    if (process.platform === 'darwin') {
      const inventory = require('../src/platform/mac-processes.cjs').scan(),
        home = loginHome;
      const processRow = inventory.processes.find(
        (p) =>
          p.context.ok &&
          require('../src/clients/client-status.cjs').sameHome(p.context.home, home),
      );
      assert.ok(processRow, 'native Codex process must be discovered with its actual CODEX_HOME');
      assert.equal(
        require('../src/clients/client-status.cjs').sameHome(processRow.context.cwd, home),
        true,
      );
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
