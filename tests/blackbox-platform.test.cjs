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
