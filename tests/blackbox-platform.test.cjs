'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { startBackend } = require('./backend-process.cjs');
const { isRust, rustBinary } = require('./backend.cjs');
const project = path.resolve(__dirname, '..');

test('双后台样例对：系统代理转换与多安装序号决策', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-platform-vector-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function run(input) {
    const source = path.join(root, 'input.json'),
      target = path.join(root, 'output.json');
    fs.writeFileSync(source, JSON.stringify(input));
    execFileSync(
      isRust ? rustBinary() : process.execPath,
      isRust
        ? ['--algorithm-fixture', source, target]
        : [path.join(__dirname, 'fixtures/diagnostics-algorithm.cjs'), source, target],
      { windowsHide: true },
    );
    return JSON.parse(fs.readFileSync(target));
  }
  assert.deepEqual(
    run({
      op: 'windowsProxyEnv',
      value: {
        enabled: 1,
        server: 'http=127.0.0.1:8080;https=127.0.0.1:8081;socks=127.0.0.1:1080',
      },
    }),
    {
      HTTP_PROXY: 'http://127.0.0.1:8080',
      HTTPS_PROXY: 'http://127.0.0.1:8081',
      ALL_PROXY: 'socks5h://127.0.0.1:1080',
    },
  );
  assert.deepEqual(run({ op: 'windowsProxyEnv', value: { enabled: 0, server: 'fixture:8' } }), {});
  for (const [old, current, expected] of [
    [9, 10, 'stopped'],
    [10, 10, 'deferred'],
    [11, 10, 'deferred'],
  ])
    assert.equal(run({ op: 'otherInstallAction', old, current }), expected);
});

function installation(sequence, discovery) {
  return ({ root, environment }) => {
    const install = path.join(root, 'install');
    for (const relative of require('../release-files.json')) {
      const target = path.join(install, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(project, relative), target);
    }
    fs.symlinkSync(
      path.join(project, 'node_modules'),
      path.join(install, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const exe = path.join(install, process.platform === 'win32' ? 'switcher.exe' : 'switcher');
    if (isRust) fs.copyFileSync(rustBinary(), exe);
    fs.writeFileSync(
      path.join(install, 'src/platform/release-info.json'),
      JSON.stringify({ sequence }),
    );
    environment.SWITCHER_BLACKBOX_PROJECT = install;
    environment.SWITCHER_BLACKBOX_EXE = exe;
    environment.SWITCHER_WEB_ROOT = path.join(install, 'web');
    environment.BRIDGE_DISCOVERY_DIR = discovery || path.join(root, 'discovery');
    fs.mkdirSync(environment.BRIDGE_DISCOVERY_DIR, { recursive: true });
    // Prevent either backend from touching the real desktop/registry.
    fs.writeFileSync(
      path.join(environment.BRIDGE_DISCOVERY_DIR, 'shortcut.json'),
      JSON.stringify({ created: true, sequence: 1000 }),
    );
  };
}

test('双后台黑盒：仅从临时可信安装查找Codex，扩展版本按数字排序', async (t) => {
  let expected;
  const f = await startBackend(t, {
    setup({ root, environment, fake }) {
      const user = path.join(root, 'fixture-user');
      fs.mkdirSync(user);
      environment[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = user;
      environment.LOCALAPPDATA = path.join(user, 'AppData', 'Local');
      environment.CODEX_EXE = '';
      const target =
        (process.platform === 'win32' ? 'windows-' : 'macos-') +
        (process.arch === 'arm64' ? 'aarch64' : 'x86_64');
      for (const version of ['1.9', '1.10']) {
        const binary = path.join(
          user,
          '.vscode',
          'extensions',
          'openai.chatgpt-' + version,
          'bin',
          target,
          path.basename(fake),
        );
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.copyFileSync(fake, binary);
        if (version === '1.10') expected = binary;
      }
    },
  });
  const response = await f.api('clients', {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).runtime, fs.realpathSync(expected));
  const data = await (await f.api('exportDiagnostics', {})).json();
  const header = JSON.parse(data.text.split('\n---\n')[0]);
  assert.equal(header.runtime.trusted, true);
  assert.equal(header.codexVersion, 'codex-fixture 0.1.0');
});

test('双后台黑盒：不同安装序号让位与升级交接，真实隔离PID停止', async (t) => {
  const old = await startBackend(t, { setup: installation(10) });
  const discovery = old.environment.BRIDGE_DISCOVERY_DIR;
  assert.equal((await (await old.api('runtime')).json()).sequence, 10);
  const lower = await startBackend(t, { setup: installation(9, discovery), expectReuse: true });
  await lower.closed;
  assert.equal(lower.child.exitCode, 0);
  assert.equal((await (await old.api('runtime')).json()).pid, old.child.pid);
  const newer = await startBackend(t, {
    setup: installation(11, discovery),
    port: Number(old.url.port),
  });
  await old.closed;
  assert.ok(old.child.exitCode !== null || old.child.signalCode !== null);
  const current = await (await newer.api('runtime')).json();
  assert.equal(current.sequence, 11);
  const rows = fs
    .readFileSync(path.join(newer.bridge, 'logs/switcher.log'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.deepEqual(rows.find((row) => row.event === 'startup').otherInstall, {
    pid: old.child.pid,
    sequence: 10,
    action: 'stopped',
  });
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(discovery, 'connection.json'))).pid,
    newer.child.pid,
  );
});

test('双后台黑盒：Insiders/Cursor及openai.codex扩展从真实临时安装路径发现', async (t) => {
  for (const [editor, id] of [
    ['.vscode-insiders', 'openai.chatgpt-1.10'],
    ['.cursor', 'openai.chatgpt-1.10'],
    ['.vscode', 'openai.codex-1.10'],
  ]) {
    let expected;
    const f = await startBackend(t, {
      setup({ root, environment, fake }) {
        const user = path.join(root, 'user');
        fs.mkdirSync(user);
        environment[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = user;
        environment.LOCALAPPDATA = path.join(user, 'AppData', 'Local');
        environment.CODEX_EXE = '';
        const target =
          (process.platform === 'win32' ? 'windows-' : 'macos-') +
          (process.arch === 'arm64' ? 'aarch64' : 'x86_64');
        const extension = path.join(user, editor, 'extensions', id);
        expected = path.join(extension, 'bin', target, path.basename(fake));
        fs.mkdirSync(path.dirname(expected), { recursive: true });
        fs.copyFileSync(fake, expected);
        fs.writeFileSync(
          path.join(extension, 'package.json'),
          JSON.stringify({
            publisher: 'OpenAI',
            name: id.startsWith('openai.codex') ? 'codex' : 'chatgpt',
            displayName: 'Codex',
          }),
        );
      },
    });
    const clients = await (await f.api('clients', {})).json();
    assert.equal(clients.runtime, fs.realpathSync(expected));
    const state = await (await f.api('state')).json();
    assert.equal(state.environment.codexTrusted, true);
  }
});

test('双后台样例对：显式代理优先且source为env', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-explicit-proxy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'in.json'),
    output = path.join(root, 'out.json');
  fs.writeFileSync(source, JSON.stringify({ op: 'proxySource', home: root }));
  const env = { ...process.env };
  for (const key of [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
  ])
    delete env[key];
  env.HTTPS_PROXY = 'http://127.0.0.1:19090';
  execFileSync(
    isRust ? rustBinary() : process.execPath,
    isRust
      ? ['--algorithm-fixture', source, output]
      : [path.join(__dirname, 'fixtures/diagnostics-algorithm.cjs'), source, output],
    { env, windowsHide: true },
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), {
    source: 'env',
    env: { HTTPS_PROXY: 'http://127.0.0.1:19090', CODEX_HOME: root },
  });
});

test('双后台黑盒：启动收紧已有文件额外授权', async (t) => {
  let file;
  const f = await startBackend(t, {
    setup({ bridge }) {
      file = path.join(bridge, 'fixture-private.json');
      fs.writeFileSync(file, '{"fixture":true}\n');
      if (process.platform === 'win32')
        execFileSync('icacls.exe', [file, '/grant', '*S-1-1-0:R'], {
          windowsHide: true,
          stdio: 'pipe',
        });
      else fs.chmodSync(file, 0o644);
    },
  });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"fixture":true}\n');
  assert.equal((await (await f.api('state')).json()).dataDirProtection.ok, true);
  if (process.platform === 'win32') {
    const env = { ...process.env, T: file };
    delete env.PSModulePath;
    const sids = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        '(Get-Acl -LiteralPath $env:T).Access | ForEach-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}',
      ],
      { env, encoding: 'utf8', windowsHide: true },
    )
      .trim()
      .split(/\r?\n/);
    assert.equal(sids.includes('S-1-1-0'), false);
    assert.equal(new Set(sids).size, 2);
    assert.ok(sids.includes('S-1-5-18'));
  } else {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.bridge).mode & 0o777, 0o700);
  }
});

test(
  '双后台黑盒：Codex.exe渲染子进程不计为另一个客户端',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = await startBackend(t);
    const app = path.join(f.root, 'OpenAI.Codex_fixture', 'app');
    fs.mkdirSync(app, { recursive: true });
    const exe = path.join(app, 'Codex.exe');
    fs.copyFileSync(process.execPath, exe);
    const { spawn } = require('node:child_process');
    const shell = spawn(
      exe,
      [
        '-e',
        "const p=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore',windowsHide:true});console.log(p.pid);setTimeout(()=>{},30000)",
      ],
      {
        cwd: f.root,
        env: { ...f.environment, CODEX_HOME: f.home },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    f.track(shell);
    const [data] = await require('node:events').once(shell.stdout, 'data');
    const renderer = Number(String(data).trim());
    assert.ok(renderer > 0);
    try {
      const response = await f.api('clients', {});
      assert.equal(response.status, 200);
      const status = await response.json();
      const rows = status.clients.filter((c) => [shell.pid, renderer].includes(c.pid));
      assert.deepEqual(
        rows.map((c) => c.pid),
        [shell.pid],
      );
      assert.equal(rows[0].home, f.home);
      assert.equal(rows[0].confirmed, true);
    } finally {
      process.kill(renderer);
      shell.kill();
      await shell.closed;
    }
  },
);
