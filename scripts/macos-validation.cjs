'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { findCodex } = require('../runtime.cjs');
const { createAccounts } = require('../accounts.cjs');
const { sameHome, configLayers } = require('../client-status.cjs');

const project = path.resolve(__dirname, '..');
const reportFile = path.join(project, 'verification', 'macos-validation.json');
const report = { platform: process.platform, arch: process.arch, checks: [] };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-macos-validation-'));
const record = (name, details = {}) => {
  report.checks.push({ name, passed: true, ...details });
};

async function validate() {
  assert.equal(process.platform, 'darwin', '此验证必须在真实 macOS 执行');
  const target = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  const version = '26.1007.21434';
  const archive = path.join(root, 'official-codex.vsix');
  const url = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/openai/vsextensions/chatgpt/${version}/vspackage?targetPlatform=${target}`;

  // 从官方 Marketplace 取得对应架构的真实 VSIX，不以桌面版二进制冒充插件版。
  cp.execFileSync(
    '/usr/bin/curl',
    [
      '--fail',
      '--location',
      '--compressed',
      '--silent',
      '--show-error',
      '--retry',
      '2',
      '--max-time',
      '240',
      url,
      '-o',
      archive,
    ],
    { timeout: 260000 },
  );
  const unpacked = path.join(root, 'unpacked');
  // 官方 VSIX 的 ZIP 布局与应用分发包不同，使用 libarchive 兼容解包。
  fs.mkdirSync(unpacked);
  cp.execFileSync('/usr/bin/tar', ['-xf', archive, '-C', unpacked]);
  const extensions = path.join(root, '.vscode', 'extensions');
  fs.mkdirSync(extensions, { recursive: true });
  const extension = path.join(extensions, `openai.chatgpt-${version}`);
  fs.renameSync(path.join(unpacked, 'extension'), extension);
  const executable = findCodex({
    platform: 'darwin',
    arch: process.arch,
    home: root,
    env: {},
    appPaths: [],
  });
  assert.ok(executable.startsWith(fs.realpathSync(extension) + path.sep));
  fs.chmodSync(executable, 0o755);
  const nativeVersion = cp.execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
  record('official-extension-discovery-without-desktop-or-CODEX_EXE', {
    extensionVersion: version,
    nativeVersion,
    archiveSha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
  });

  // 显式 CODEX_HOME 与继承 HOME 的默认目录分别验证；两种启动方式都使用真实插件程序。
  for (const mode of ['explicit-home', 'default-home']) {
    const home = path.join(root, mode);
    const bridge = path.join(home, 'bridge');
    fs.mkdirSync(bridge, { recursive: true });
    const defaultHome = path.join(home, '.codex');
    fs.mkdirSync(defaultHome);
    fs.writeFileSync(
      path.join(defaultHome, 'config.toml'),
      '[features]\nplugins=false\nremote_plugin=false\n',
    );
    let child;
    const manager = createAccounts({
      codexHome: defaultHome,
      bridgeHome: bridge,
      codexExe: executable,
      spawnProcess: (exe, args, options) => {
        const env = { ...options.env, HOME: home };
        if (mode === 'default-home') delete env.CODEX_HOME;
        child = cp.spawn(exe, ['--model', 'mac-fixture', ...args], { ...options, env });
        return child;
      },
    });
    try {
      const login = await manager.startLogin();
      assert.equal(login.status, 'waiting');
      assert.equal(new URL(login.authUrl).protocol, 'https:');
      const raw = cp.execFileSync(
        path.join(project, 'bin', 'mac-process-context'),
        [String(child.pid)],
        { encoding: 'utf8' },
      );
      const context = JSON.parse(raw);
      const expected =
        mode === 'default-home' ? defaultHome : path.join(bridge, 'accounts', 'login');
      assert.equal(context.ok, true, context.error);
      assert.ok(sameHome(context.home, expected));
      assert.equal(context.overrides.model, 'mac-fixture');
      const discovered = require('../mac-processes.cjs')
        .scan()
        .processes.find((row) => row.pid === child.pid);
      assert.ok(discovered?.context.ok, '真实 Codex 进程必须被 ps 与原生助手共同识别');
      assert.ok(sameHome(discovered.context.home, expected));
      record(`native-process-and-login-${mode}`);
    } finally {
      await manager.cancelLogin();
    }
    assert.equal(manager.status().items.length, 0);
  }

  const selectedHome = path.join(root, 'selected-home');
  const alternateHome = path.join(root, 'alternate-home');
  const bridgeHome = path.join(root, 'service');
  for (const dir of [selectedHome, alternateHome, bridgeHome]) fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(selectedHome, 'config.toml'),
    'model="first-model"\n[profiles.review]\nmodel="profile-model"\n',
  );
  fs.writeFileSync(path.join(alternateHome, 'config.toml'), 'model="second-model"\n');
  const service = require('../service.cjs').createService({ codexHome: selectedHome, bridgeHome });
  assert.equal((await service.state()).current.model, 'first-model');
  assert.equal(
    configLayers(selectedHome, null, 'review').find((row) => row.source === '启动配置档').values
      .model,
    'profile-model',
  );
  await service.actions.setEnvironment({ home: alternateHome, codexExe: executable });
  assert.equal((await service.state()).current.model, 'second-model');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(bridgeHome, 'settings.json'))).codexHome,
    alternateHome,
  );
  record('configuration-home-and-profile-read');

  // 启动两棵独立进程树，分别承载共享目录与独立目录的真实官方后端。
  // 验证 Mac 的父子进程关联不会把所有编辑器窗口一起重载。
  const wrapperFile = path.join(root, 'editor-process-fixture.cjs');
  fs.writeFileSync(
    wrapperFile,
    `
    const {spawn}=require('node:child_process');
    const backend=spawn(process.argv[2],['app-server'],{stdio:['pipe','pipe','inherit']});
    process.stdin.pipe(backend.stdin);backend.stdout.pipe(process.stdout);
    process.on('SIGTERM',()=>{backend.kill();backend.once('close',()=>process.exit(0))});
    backend.on('exit',()=>process.exit(0));
  `,
  );
  const editorProcesses = [];
  try {
    for (const [label, home] of [
      ['shared', selectedHome],
      ['separate', alternateHome],
    ]) {
      const child = cp.spawn(process.execPath, [wrapperFile, executable], {
        cwd: root,
        env: { ...process.env, CODEX_HOME: home },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const closed = new Promise((resolve) => child.once('close', resolve));
      editorProcesses.push({ child, closed });
      child.stderr.resume();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('编辑器后端初始化超时')), 10000);
        let buffer = '';
        child.stdout.on('data', (chunk) => {
          buffer += chunk;
          const line = buffer.split('\n').find((value) => value.includes('"id":1'));
          if (!line) return;
          try {
            const message = JSON.parse(line);
            if (message.result) {
              clearTimeout(timer);
              resolve();
            }
          } catch {}
        });
        child.stdin.write(
          JSON.stringify({
            id: 1,
            method: 'initialize',
            params: { clientInfo: { name: 'editor-fixture', version: '1' } },
          }) + '\n',
        );
      });
      require('../client-status.cjs').heartbeat(bridgeHome, {
        id: `mac-editor-${label}`,
        pid: child.pid,
        name: 'VS Code fixture',
        home,
      });
    }
    const clientStatus = require('../client-status.cjs');
    const rows = clientStatus.clientStatus(selectedHome, bridgeHome).clients;
    assert.equal(rows.find((row) => row.id === 'editor-mac-editor-shared')?.canReload, true);
    assert.equal(rows.find((row) => row.id === 'editor-mac-editor-separate')?.canReload, false);
    assert.equal(clientStatus.requestReload(selectedHome, bridgeHome).count, 1);
    const sharedFile = path.join(bridgeHome, 'clients', 'mac-editor-shared.json');
    const command = JSON.parse(fs.readFileSync(sharedFile)).command;
    assert.equal(command.type, 'reload');
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(bridgeHome, 'clients', 'mac-editor-separate.json')))
        .command,
      null,
    );
    clientStatus.heartbeat(bridgeHome, {
      id: 'mac-editor-shared',
      pid: editorProcesses[0].child.pid,
      home: selectedHome,
      ack: command.id,
      ackStatus: 'reload_requested',
    });
    assert.equal(JSON.parse(fs.readFileSync(sharedFile)).lastAck.status, 'reload_requested');
    record('native-editor-backend-home-isolation-and-reload-command');
  } finally {
    for (const { child } of editorProcesses) child.kill();
    await Promise.all(editorProcesses.map(({ closed }) => closed));
  }

  // 钥匙串也使用独立测试文件与合成登录，完成后恢复原搜索列表。
  // 此处验证的是系统钥匙串读取链路，不接触个人账号，也不访问官方额度。
  const keychainHome = path.join(root, 'keychain-home');
  const keychainBridge = path.join(root, 'keychain-bridge');
  const keychain = path.join(root, 'fixture.keychain-db');
  fs.mkdirSync(keychainHome);
  fs.mkdirSync(keychainBridge);
  fs.writeFileSync(
    path.join(keychainHome, 'config.toml'),
    'cli_auth_credentials_store="keyring"\n',
  );
  const security = (...args) => cp.execFileSync('/usr/bin/security', args, { encoding: 'utf8' });
  const originalSearch = security('list-keychains', '-d', 'user')
    .split('\n')
    .map((line) => line.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  const storeKey =
    'cli|' +
    crypto.createHash('sha256').update(fs.realpathSync(keychainHome)).digest('hex').slice(0, 16);
  const token =
    'fixture.' +
    Buffer.from(JSON.stringify({ email: 'keychain@example.test' })).toString('base64url') +
    '.fixture';
  const syntheticAuth = {
    auth_mode: 'chatgpt',
    tokens: {
      account_id: 'fixture-keychain',
      access_token: token,
      id_token: token,
      refresh_token: 'fixture-old',
    },
    last_refresh: '2026-01-01T00:00:00Z',
  };
  try {
    security('create-keychain', '-p', 'fixture-only', keychain);
    security('unlock-keychain', '-p', 'fixture-only', keychain);
    security(
      'add-generic-password',
      '-s',
      'Codex Auth',
      '-a',
      storeKey,
      '-w',
      JSON.stringify(syntheticAuth),
      '-T',
      '/usr/bin/security',
      keychain,
    );
    security('list-keychains', '-d', 'user', '-s', keychain, ...originalSearch);
    const manager = createAccounts({ codexHome: keychainHome, bridgeHome: keychainBridge });
    await manager.syncCurrent();
    const account = manager.status().items.find((row) => row.current);
    assert.equal(account?.email, 'keychain@example.test');
    assert.equal(fs.existsSync(path.join(keychainHome, 'auth.json')), false);
    record('macOS-keychain-account-read-with-synthetic-login');

    // 覆盖 Windows 曾出现的“退出时刷新了登录，但保存副本仍是旧令牌”。
    // 通过真实钥匙串写入模拟客户端退出瞬间的刷新，调用生产切换流程核对。
    const refreshedAuth = {
      ...syntheticAuth,
      tokens: { ...syntheticAuth.tokens, refresh_token: 'fixture-new' },
      last_refresh: '2026-01-02T00:00:00Z',
    };
    await require('../desktop-account.cjs').runSwitch(
      {
        codexHome: keychainHome,
        bridgeHome: keychainBridge,
        id: account.id,
        desktopExe: 'fixture-desktop',
        reloadEditors: false,
      },
      {
        accounts: manager,
        stop: async () => {
          security(
            'add-generic-password',
            '-U',
            '-s',
            'Codex Auth',
            '-a',
            storeKey,
            '-w',
            JSON.stringify(refreshedAuth),
            keychain,
          );
        },
        open: async () => {},
      },
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(keychainHome, 'auth.json'))).tokens.refresh_token,
      'fixture-new',
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(keychainBridge, 'accounts', account.id, 'auth.json')))
        .tokens.refresh_token,
      'fixture-new',
    );
    record('keychain-latest-login-preserved-during-account-switch');
  } finally {
    security('list-keychains', '-d', 'user', '-s', ...originalSearch);
    if (fs.existsSync(keychain)) security('delete-keychain', keychain);
  }

  // 同一份真实额度 RPC 并发场景在两种 Mac 架构分别运行。
  // 测试网络只连接本机合成服务，不使用真实账号或官方额度。
  const result = cp.spawnSync(
    process.execPath,
    ['--test', '--test-timeout=120000', 'native-quota.test.cjs', 'thread-routing.test.cjs'],
    {
      cwd: project,
      env: { ...process.env, CODEX_EXE: executable },
      encoding: 'utf8',
      timeout: 130000,
    },
  );
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.equal(result.status, 0, '官方插件内置程序的额度并发验证失败');
  record('official-extension-native-quota-concurrency-with-local-fixtures');
  record('official-extension-thread-provider-switch-and-cold-restart');
}

(async () => {
  try {
    await validate();
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    report.checkedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  console.log(JSON.stringify(report));
})();
