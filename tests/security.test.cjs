// 安全验收：从“同机其他进程”的角度核对 #1 会话、#2 可执行文件路径、#3 数据目录权限。
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  cp = require('node:child_process');
const { runPage } = require('./fake-page.cjs');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-security-' + name + '-'));

test('#1 页面用启动网址里的令牌换取会话，并立即从地址栏去掉', async () => {
  const page = await runPage({
    hash: '#launch-token',
    respond: (route) => ({ status: route === 'session' ? 204 : 500 }),
  });
  assert.deepEqual(page.history, ['/']);
  const [first, second] = page.requests;
  assert.equal(first.url, '/api/session');
  assert.equal(first.method, 'POST');
  assert.equal(first.headers.Authorization, 'Bearer launch-token');
  // 其余接口必须等会话建立后才发出，否则首个请求会因为没有 Cookie 被拒绝。
  assert.ok(second.url.startsWith('/api/') && second.url !== '/api/session');
});

test('#1 会话无效时显示重新打开的提示，不再访问主页重取凭证', async () => {
  const page = await runPage({ hash: '', respond: () => ({ status: 401 }) });
  assert.equal(page.byId('session-notice').hidden, false);
  assert.equal(page.workspace.hidden, true);
  assert.equal(page.byId('summary').textContent, '未连接本机会话');
  assert.equal(page.requests.length, 1, '会话失效后不应继续发请求');
  assert.equal(
    page.requests.some((r) => r.url === '/'),
    false,
  );
});

test('#1 直接打开主页不建立会话', async () => {
  const page = await runPage({ hash: '', respond: () => ({ status: 401 }) });
  assert.equal(
    page.requests.some((r) => r.url === '/api/session'),
    false,
  );
  assert.deepEqual(page.history, []);
});

// 在临时目录伪造一个名为 codex 的程序，代表同机其他进程放下的可执行文件。
function fakeCodex(dir) {
  const file = path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
  fs.writeFileSync(file, 'not codex');
  return file;
}

test('#2 伴随扩展心跳上报的非官方路径不会被保存', () => {
  const bridge = tmp('bridge'),
    planted = fakeCodex(tmp('planted'));
  const extension = tmp('extension');
  const target =
    (process.platform === 'win32'
      ? 'windows-'
      : process.platform === 'darwin'
        ? 'macos-'
        : 'linux-') + (process.arch === 'arm64' ? 'aarch64' : 'x86_64');
  fs.mkdirSync(path.join(extension, 'bin', target), { recursive: true });
  fakeCodex(path.join(extension, 'bin', target));
  require('../src/clients/client-status.cjs').heartbeat(bridge, {
    id: 'attacker-client',
    pid: process.pid,
    codexExe: planted,
    extensionPath: extension,
  });
  const row = JSON.parse(
    fs.readFileSync(path.join(bridge, 'clients', 'attacker-client.json'), 'utf8'),
  );
  assert.equal(row.codexExe, null);
  assert.equal(row.extensionPath, null);
});

test('#2 官方扩展目录内的程序仍被认可', () => {
  const home = tmp('home');
  const dir = path.join(home, '.vscode', 'extensions', 'openai.chatgpt-1.0.0', 'bin', 'x');
  fs.mkdirSync(dir, { recursive: true });
  const { isTrustedCodex } = require('../src/platform/runtime.cjs');
  assert.equal(isTrustedCodex(fakeCodex(dir), { home }), true);
  assert.equal(isTrustedCodex(fakeCodex(tmp('elsewhere')), { home }), false);
});

test('#2 未经确认的自定义路径被拒绝，确认后只认这一个文件', async () => {
  const bridge = tmp('bridge'),
    codexHome = tmp('codex-home'),
    planted = fakeCodex(tmp('custom'));
  const { createService } = require('../src/server/service.cjs');
  const { findCodex } = require('../src/platform/runtime.cjs');
  const service = createService({ codexHome, bridgeHome: bridge });
  await assert.rejects(service.actions.setEnvironment({ home: codexHome, codexExe: planted }), {
    code: 'untrusted_codex',
  });
  assert.equal(fs.existsSync(path.join(bridge, 'settings.json')), false);

  await service.actions.setEnvironment({
    home: codexHome,
    codexExe: planted,
    allowUntrusted: true,
  });
  // 此处验证用户设置，排除 CI 为真实运行时设置的 CODEX_EXE 覆盖。
  assert.equal(findCodex({ dataHome: bridge, env: {} }), fs.realpathSync(planted));

  // 设置文件被改成另一个未确认的程序时，不能沿用之前的确认。
  const settingsFile = path.join(bridge, 'settings.json'),
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ ...settings, codexExe: fakeCodex(tmp('swapped')) }),
  );
  assert.throws(() => findCodex({ dataHome: bridge, env: {} }), { code: 'untrusted_codex' });
  // 显式环境变量仍按约定优先，不能为通过设置测试而改变实际查找顺序。
  assert.equal(findCodex({ dataHome: bridge, env: { CODEX_EXE: planted } }), planted);
});

// 页面状态来自真实 service；clients 会探测本机进程，这里固定为空。
function pageBackend(options = {}, routes = {}) {
  const root = tmp('page');
  fs.mkdirSync(path.join(root, 'codex'));
  fs.writeFileSync(path.join(root, 'codex', 'config.toml'), 'model="gpt-5"\n');
  const { createService } = require('../src/server/service.cjs');
  const service = createService({
    codexHome: path.join(root, 'codex'),
    bridgeHome: path.join(root, 'bridge'),
    ...options,
  });
  return async (route, body) => {
    if (routes[route]) return routes[route](body);
    if (route === 'state') return { body: await service.state() };
    if (route === 'accounts') return { body: { items: [], switchJob: null } };
    if (route === 'clients')
      return { body: { home: '', clients: [], auxiliary: [], editors: [], connectedEditors: 0 } };
    return { body: { message: route + ' ok' } };
  };
}
const untrustedFirst = (body) =>
  body.allowUntrusted
    ? { body: { message: '已保存' } }
    : { status: 400, body: { code: 'untrusted_codex', error: '该程序不在自动识别的安装目录中' } };

async function saveEnvironment(answer) {
  const prompts = [];
  const page = await runPage({
    respond: pageBackend({}, { setEnvironment: untrustedFirst }),
    confirm: (text) => (prompts.push(text), answer),
  });
  page.byId('config-home').value = 'C:\\codex-home';
  page.byId('runtime-path').value = ' D:\\tools\\codex.exe ';
  await page.byId('environment-save').onclick();
  return { page, prompts };
}

test('#2 自定义程序不在官方目录时，先让用户确认再保存', async () => {
  const { page, prompts } = await saveEnvironment(true);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes('D:\\tools\\codex.exe'));
  const saves = page.calls('setEnvironment');
  assert.equal(saves.length, 2);
  assert.equal(saves[0].body.allowUntrusted, undefined);
  assert.equal(saves[1].body.allowUntrusted, true);
});

test('#2 用户不确认时不保存程序路径', async () => {
  const { page } = await saveEnvironment(false);
  assert.equal(page.calls('setEnvironment').length, 1);
  assert.equal(page.byId('status').textContent, '未保存：程序路径未确认。');
});

test('#3 数据目录权限未收紧时页面明确提示', async () => {
  const failed = await runPage({
    respond: pageBackend({
      dataDirProtection: { ok: false, path: 'D:\\switcher', error: 'D:\\switcher：拒绝访问' },
    }),
  });
  assert.equal(failed.byId('protection-notice').hidden, false);
  assert.ok(failed.byId('protection-notice').textContent.includes('D:\\switcher：拒绝访问'));
  const ok = await runPage({ respond: pageBackend() });
  assert.equal(ok.byId('protection-notice').hidden, true);
});

test(
  '#3 启动时收紧数据目录，已有文件的额外授权也被清除',
  { skip: process.platform !== 'win32' && '仅 Windows 依赖 ACL' },
  () => {
    const dir = tmp('data'),
      file = path.join(dir, 'auth.json');
    fs.writeFileSync(file, '{}');
    // 模拟解压到所有用户可读的位置：给 Everyone 显式读取权限。
    cp.execFileSync('icacls.exe', [file, '/grant', '*S-1-1-0:R'], { stdio: 'pipe' });
    const result = require('../src/platform/data-protection.cjs').protectDataDirs([dir]);
    assert.deepEqual(result, { ok: true, path: dir });
    // 与 privateAcl 一致：从 PowerShell 7 启动时继承的 PSModulePath 会让 5.1 找不到 Get-Acl。
    const ps = (command, extra = {}) => {
      const env = { ...process.env, ...extra };
      delete env.PSModulePath;
      return cp
        .execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
          env,
          encoding: 'utf8',
        })
        .trim();
    };
    const sids = (target) =>
      ps(
        '(Get-Acl -LiteralPath $env:T).Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }',
        { T: target },
      ).split(/\r?\n/);
    const me = ps('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
    for (const target of [dir, file])
      assert.deepEqual([...new Set(sids(target))].sort(), [me, 'S-1-5-18'].sort(), target);
  },
);
