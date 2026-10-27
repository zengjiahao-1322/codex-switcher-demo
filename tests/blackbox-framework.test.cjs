'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startBackend } = require('./backend-process.cjs');

test('双后台黑盒：临时开机自启文件启用禁用和首次空配置启动', async (t) => {
  const f = await startBackend(t, { missingConfig: true });
  assert.equal((await f.api('state')).status, 200);
  const directory = f.environment.BRIDGE_STARTUP_DIR;
  assert.equal((await f.api('autostart', { enabled: true })).status, 200);
  const files = fs.readdirSync(directory);
  assert.equal(files.length, 1);
  const file = path.join(directory, files[0]);
  assert.ok(fs.statSync(file).size > 100);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.bridge, 'adapter.json'))).autostartDecided,
    true,
  );
  assert.equal((await f.api('autostart', { enabled: false })).status, 200);
  assert.equal(fs.existsSync(file), false);
});

test('双后台黑盒：选择配置目录与非可信Codex路径需要明确确认', async (t) => {
  const f = await startBackend(t);
  const home = path.join(f.root, '中文 配置');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model="changed-fixture"\n');
  const input = { home, codexExe: f.environment.CODEX_EXE };
  assert.equal((await f.api('setEnvironment', input)).status, 400);
  assert.equal((await f.api('setEnvironment', { ...input, allowUntrusted: true })).status, 200);
  assert.equal((await (await f.api('state')).json()).current.model, 'changed-fixture');
  const settings = JSON.parse(fs.readFileSync(path.join(f.bridge, 'settings.json')));
  assert.equal(settings.codexHome, home);
  assert.equal(settings.approvedCodexPath, fs.realpathSync(input.codexExe));
});

test('双后台黑盒：页面公开、Bearer换会话、Cookie和Origin/Host隔离', async (t) => {
  const f = await startBackend(t);
  const page = await f.request('/');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('set-cookie'), null);
  assert.ok((await page.text()).includes('Codex'));
  assert.equal((await f.request('/api/runtime')).status, 401);
  assert.equal((await f.request('/api/session', { method: 'POST' })).status, 401);
  const login = await f.request('/api/session', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + f.token },
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\/api\//);
  const runtime = await f.request('/api/runtime', { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(runtime.status, 200);
  assert.equal((await runtime.json()).pid, f.child.pid);
  assert.equal(
    (
      await f.request('/api/runtime', {
        headers: { Authorization: 'Bearer ' + f.token, Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  const hostStatus = await new Promise((resolve, reject) => {
    require('node:http')
      .get(f.url.origin + '/', { headers: { Host: 'evil.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
      .on('error', reject);
  });
  assert.equal(hostStatus, 403);
});

test('双后台黑盒：静态模块与CSP、缓存及路径边界', async (t) => {
  const f = await startBackend(t);
  const page = await f.request('/');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  await page.text();
  const script = await f.request('/js/views/accounts.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /^text\/javascript/);
  assert.ok((await script.text()).includes('renderAccounts'));
  assert.equal((await f.request('/package.json')).status, 404);
  assert.equal((await f.request('/%2e%2e%5cpackage.json')).status, 404);
});

test('双后台黑盒：GET state读取隔离配置且返回可用运行摘要', async (t) => {
  const f = await startBackend(t);
  fs.writeFileSync(
    path.join(f.bridge, 'providers.json'),
    JSON.stringify({
      providers: [
        {
          id: 'fixture-provider',
          name: '隔离供应商',
          baseUrl: 'https://fixture.invalid/v1',
          apiMode: 'responses',
          model: 'fixture-model',
          apiKey: 'synthetic-fixture-private-key',
        },
      ],
    }),
  );
  const response = await f.api('state');
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.current.model, 'blackbox-fixture');
  assert.equal(state.current.official, true);
  assert.ok(Array.isArray(state.providers));
  assert.equal(state.providers[0].id, 'official');
  assert.equal(state.providers[1].hasKey, true);
  assert.equal(JSON.stringify(state).includes('synthetic-fixture-private-key'), false);
  assert.equal(typeof state.dataDirProtection.ok, 'boolean');
  assert.equal(state.catalog.selected, false);
  assert.equal(state.codexVersion, 'codex-fixture 0.1.0');
  assert.equal(state.mcp.installed, false);
});

test('双后台黑盒：API方法、JSON类型、正文大小和解析错误保持Node协议', async (t) => {
  const f = await startBackend(t);
  const headers = { Authorization: 'Bearer ' + f.token };
  assert.equal((await f.request('/api/session', { headers })).status, 405);
  assert.equal((await f.request('/api/notAnAction', { headers })).status, 405);
  assert.equal((await f.request('/api/notAnAction', { method: 'POST', headers })).status, 404);
  assert.equal((await f.api('state', {})).status, 404);
  const post = (body, type = 'application/json') =>
    f.request('/api/exportDiagnostics', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': type },
      body,
    });
  assert.equal((await post('{}', 'text/plain')).status, 415);
  assert.equal((await post('{broken')).status, 400);
  assert.equal((await post(JSON.stringify({ text: '中'.repeat(6000) }))).status, 413);
  assert.equal((await f.api('runtime')).status, 200, '拒绝请求后服务仍可用');
});

test('双后台黑盒：启动运行记录与HTTP runtime一致且重复启动复用原实例', async (t) => {
  const f = await startBackend(t);
  const runningFile = path.join(f.bridge, 'running.json');
  const running = JSON.parse(fs.readFileSync(runningFile, 'utf8'));
  const runtime = await (await f.api('runtime')).json();
  assert.equal(running.pid, f.child.pid);
  assert.equal(new URL(running.url).origin, f.url.origin);
  assert.equal(running.build.pid, runtime.pid);
  assert.equal(running.build.id, runtime.id);
  assert.equal(running.build.version, runtime.version);
  assert.equal(typeof runtime.id, 'string');
  const { launchBackend } = require('./backend-process.cjs');
  const second = launchBackend(f.environment);
  const closed = require('node:events').once(second, 'close');
  t.after(async () => {
    if (second.exitCode === null && second.signalCode === null) second.kill();
    await closed;
  });
  second.stdout.resume();
  second.stderr.resume();
  const [code] = await closed;
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(runningFile, 'utf8')), running);
  assert.equal((await f.api('runtime')).status, 200);
});

test('双后台黑盒：VSIX下载凭一次性URL且取回后失效', async (t) => {
  const f = await startBackend(t);
  const result = await (await f.api('companionPackage', {})).json();
  assert.equal(result.filename, 'codex-switcher-companion.vsix');
  assert.match(result.url, /^\/download\/[a-f0-9]{48}$/);
  const response = await f.request(result.url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /codex-switcher-companion\.vsix/);
  const archive = Buffer.from(await response.arrayBuffer());
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.ok(archive.includes(Buffer.from('extension/package.json')));
  assert.ok(archive.includes(Buffer.from('extension/extension.cjs')));
  assert.equal((await f.request(result.url)).status, 404);
});

test('双后台黑盒：clients动作通过HTTP返回隔离进程清单和运行程序摘要', async (t) => {
  const f = await startBackend(t);
  const child = require('node:child_process').spawn(f.environment.CODEX_EXE, ['app-server'], {
    env: { ...f.environment, SWITCHER_PRIVATE_SENTINEL: 'fixture-private-must-not-leak' },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  f.track(child);
  const closed = require('node:events').once(child, 'close');
  t.after(async () => {
    child.kill();
    await closed;
  });
  child.stderr.resume();
  const initialized = require('node:events').once(child.stdout, 'data');
  child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: {} }) + '\n');
  await initialized;
  const response = await f.api('clients', {});
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.ok(Array.isArray(value.clients));
  assert.ok(Array.isArray(value.remotes));
  assert.ok(Array.isArray(value.editors));
  assert.ok(Object.hasOwn(value, 'runtime'));
  const processRow = value.clients.find((row) => row.pid === child.pid);
  assert.ok(processRow, '隔离假codex必须由真实进程扫描发现');
  assert.equal(processRow.home, f.home);
  assert.equal(processRow.confirmed, true);
  assert.equal(processRow.shared, true);
  assert.equal(JSON.stringify(value).includes('fixture-private-must-not-leak'), false);
  const exported = await (await f.api('exportDiagnostics', {})).json();
  const diagnostic = JSON.parse(exported.text.split('\n---\n')[0]);
  const row = diagnostic.clients.find((row) => row.pid === child.pid);
  assert.ok(row);
  assert.ok(row.chain.some((value) => value.startsWith(child.pid + ':')));
  assert.ok(row.chain.some((value) => value.startsWith(process.pid + ':')));
});

test('双后台黑盒：固定端口交接只停止同安装隔离后台，外部占用回退随机端口', async (t) => {
  const prior = await startBackend(t);
  const closed = require('node:events').once(prior.child, 'close');
  const next = await startBackend(t, { port: Number(prior.url.port) });
  assert.equal(next.url.port, prior.url.port);
  await closed;
  assert.notEqual(prior.child.exitCode, null);
  const rows = fs
    .readFileSync(path.join(next.bridge, 'logs', 'switcher.log'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(rows.find((row) => row.event === 'startup').reclaimed.pid, prior.child.pid);
  const foreign = require('node:http').createServer((_, response) =>
    response.end('foreign fixture'),
  );
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => foreign.close(resolve)));
  const occupied = foreign.address().port;
  const fallback = await startBackend(t, { port: occupied });
  assert.notEqual(Number(fallback.url.port), occupied);
  assert.equal(
    await fetch('http://127.0.0.1:' + occupied).then((response) => response.text()),
    'foreign fixture',
  );
  const events = fs
    .readFileSync(path.join(fallback.bridge, 'logs', 'switcher.log'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(events.find((row) => row.event === 'startup').portFallback.port, occupied);
});
