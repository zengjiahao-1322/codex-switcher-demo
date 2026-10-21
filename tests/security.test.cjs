// 安全验收：从“同机其他进程”的角度核对 #1 会话、#2 可执行文件路径、#3 数据目录权限。
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  vm = require('node:vm'),
  cp = require('node:child_process');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-security-' + name + '-'));

// 任意属性、调用都返回自身的假元素，只记录页面实际写入的属性，供断言读取。
function element() {
  const props = {};
  const self = new Proxy(function () {}, {
    get: (_, key) => {
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return () => '';
      if (key === Symbol.iterator) return () => [][Symbol.iterator]();
      return key in props ? props[key] : self;
    },
    set: (_, key, value) => {
      props[key] = value;
      return true;
    },
    apply: () => self,
    construct: () => self,
  });
  return self;
}

// 在假页面里执行真实的 web/app.js，返回页面发出的请求和页面元素。
async function runPage({ hash, respond }) {
  const elements = new Map(),
    requests = [],
    history = [];
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const document = element();
  document.getElementById = byId;
  const context = {
    document,
    location: { hash, pathname: '/', search: '' },
    history: { replaceState: (_, __, url) => history.push(url) },
    fetch: async (url, options = {}) => {
      requests.push({ url, method: options.method || 'GET', headers: options.headers || {} });
      const { status, body = {} } = respond(url, options);
      return { status, ok: status < 300, json: async () => body, text: async () => '' };
    },
    console,
    URL,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    queueMicrotask,
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8'), context);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { requests, history, byId };
}

test('#1 页面用启动网址里的令牌换取会话，并立即从地址栏去掉', async () => {
  const page = await runPage({
    hash: '#launch-token',
    respond: (url) => (url === '/api/session' ? { status: 204 } : { status: 500 }),
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
    (process.platform === 'win32' ? 'windows-' : process.platform === 'darwin' ? 'macos-' : 'linux-') +
    (process.arch === 'arm64' ? 'aarch64' : 'x86_64');
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

  await service.actions.setEnvironment({ home: codexHome, codexExe: planted, allowUntrusted: true });
  assert.equal(findCodex({ dataHome: bridge }), fs.realpathSync(planted));

  // 设置文件被改成另一个未确认的程序时，不能沿用之前的确认。
  const settingsFile = path.join(bridge, 'settings.json'),
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ ...settings, codexExe: fakeCodex(tmp('swapped')) }),
  );
  assert.throws(() => findCodex({ dataHome: bridge }), { code: 'untrusted_codex' });
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
    const sids = (target) =>
      cp
        .execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '(Get-Acl -LiteralPath $env:T).Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }',
          ],
          { env: { ...process.env, T: target }, encoding: 'utf8' },
        )
        .trim()
        .split(/\r?\n/);
    const me = cp
      .execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],
        { encoding: 'utf8' },
      )
      .trim();
    for (const target of [dir, file])
      assert.deepEqual([...new Set(sids(target))].sort(), [me, 'S-1-5-18'].sort(), target);
  },
);
