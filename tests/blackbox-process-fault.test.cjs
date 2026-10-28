'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { spawn, execFileSync } = require('node:child_process'),
  { once } = require('node:events');
const {
  officialFixture,
  auth,
  accountId,
  accounts,
  until,
} = require('./official-blackbox-helpers.cjs');
const { api, isolatedEditor, read, algorithm } = require('./config-blackbox-helpers.cjs');
async function fixture(t) {
  const f = await officialFixture(t, {
    live: auth('target'),
    setup(context) {
      if (process.platform === 'darwin') {
        const library = path.join(context.root, 'process-deny.dylib'),
          marker = path.join(context.root, 'denied-pid');
        execFileSync('clang', [
          '-Wall',
          '-Wextra',
          '-dynamiclib',
          path.join(__dirname, 'fixtures/process-deny.c'),
          '-o',
          library,
        ]);
        context.environment.DYLD_INSERT_LIBRARIES = library;
        context.environment.SWITCHER_FIXTURE_PROCESS_DENY = marker;
      }
    },
  });
  await accounts(f);
  fs.writeFileSync(path.join(f.home, 'auth.json'), JSON.stringify(auth('outgoing')));
  await accounts(f);
  await isolatedEditor(t, f);
  return f;
}
async function fakeProcess(f, desktop = false) {
  let exe = f.environment.CODEX_EXE;
  if (desktop) {
    exe =
      process.platform === 'win32'
        ? path.join(f.root, 'OpenAI.Codex_fixture', 'app', 'ChatGPT.exe')
        : path.join(f.root, 'Codex.app', 'Contents', 'MacOS', 'Codex');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.copyFileSync(f.environment.CODEX_EXE, exe);
  }
  const environment = { ...f.environment };
  delete environment.SWITCHER_FAKE_CODEX_SCENARIO;
  const child = spawn(exe, ['app-server'], {
    cwd: f.root,
    env: environment,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  f.track(child);
  child.stderr.resume();
  const ready = once(child.stdout, 'data');
  child.stdin.write('{"id":1,"method":"initialize","params":{}}\n');
  await ready;
  return { child, exe };
}
async function deny(f, target, query) {
  if (process.platform === 'darwin') {
    const marker = f.environment.SWITCHER_FIXTURE_PROCESS_DENY;
    fs.writeFileSync(marker, target.child.pid + ' ' + (query ? 1 : 0));
    return async () => fs.writeFileSync(marker, '0 0');
  }
  const exe = path.join(f.root, 'deny-controller.exe');
  execFileSync(
    path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/out:' + exe, path.join(__dirname, 'fixtures/process-deny.cs')],
    { windowsHide: true, stdio: 'pipe' },
  );
  const child = spawn(exe, [String(target.child.pid), target.exe, query ? '1401' : '1'], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let error = '';
  child.stderr.on('data', (b) => {
    error += b;
  });
  const exit = once(child, 'close');
  const ready = await Promise.race([
    once(child.stdout, 'data'),
    exit.then(() => {
      throw Error('DACL controller failed: ' + error);
    }),
  ]);
  assert.equal(String(ready[0]).trim(), 'ready');
  return async () => {
    child.stdin.end('release\n');
    await exit;
    assert.equal(child.exitCode, 0, error);
  };
}
test('进程故障黑盒：仅TEMP假进程被拒绝访问，真实停止函数保留权限失败而非当作退出', async (t) => {
  const f = await fixture(t),
    target = await fakeProcess(f),
    release = await deny(f, target, true);
  try {
    const result = algorithm(t, { op: 'stopProcess', pid: target.child.pid }, { ...f.environment });
    assert.deepEqual(result, { failed: true, permissionDenied: true });
    const ready = once(target.child.stdout, 'data');
    target.child.stdin.write('{"id":9,"method":"initialize","params":{}}\n');
    assert.equal(JSON.parse(String((await ready)[0])).id, 9);
  } finally {
    await release();
  }
});
test('并行释放故障黑盒：假桌面拒绝停止后恢复已停止编辑器，配置与登录全文保持', async (t) => {
  if (process.platform === 'darwin') {
    t.skip(
      'macOS CI 禁止对 Node 进程稳定注入 DYLD kill 权限错误；Windows DACL 与本地双端已测，真机权限边界保留未测',
    );
    return;
  }
  const f = await fixture(t),
    target = await fakeProcess(f, true);
  const status = await until(
      async () => api(f, 'clients', {}),
      (s) =>
        s.clients.some(
          (x) => x.pid === target.child.pid && x.kind === 'desktop' && x.confirmed && x.shared,
        ),
    ),
    editor = status.clients.find((x) => x.kind === 'ide' && x.shared);
  assert.ok(
    status.clients.some(
      (x) => x.pid === target.child.pid && x.kind === 'desktop' && x.confirmed && x.shared,
    ),
  );
  assert.ok(editor);
  const before = read(f),
    authBefore = read(f, 'auth.json'),
    release = await deny(f, target, false);
  try {
    await api(f, 'accountSwitch', { id: accountId('target'), threadFollow: 'off' });
    const file = path.join(f.bridge, 'account-switch.json');
    const result = await until(
      async () => JSON.parse(fs.readFileSync(file)),
      (j) => ['done', 'error'].includes(j.status),
      20000,
    );
    assert.equal(result.status, 'error', JSON.stringify(result));
    assert.equal(result.configurationApplied, false);
    assert.equal(read(f), before);
    assert.equal(read(f, 'auth.json'), authBefore);
    assert.equal(result.editorReload.count, 1);
    const row = JSON.parse(fs.readFileSync(path.join(f.bridge, 'clients/fixture-editor.json')));
    assert.equal(row.command.type, 'reload');
    await until(
      async () => api(f, 'clients', {}),
      (s) => !s.clients.some((x) => x.pid === editor.pid),
    );
    assert.equal(target.child.exitCode, null);
    assert.ok(result.steps.some((x) => x.status === 'error'));
    const ready = once(target.child.stdout, 'data');
    target.child.stdin.write('{"id":9,"method":"initialize","params":{}}\n');
    assert.equal(JSON.parse(String((await ready)[0])).id, 9);
  } finally {
    await release();
  }
});
