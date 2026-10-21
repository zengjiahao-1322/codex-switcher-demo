'use strict';

const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  net = require('node:net'),
  { spawn } = require('node:child_process'),
  { once } = require('node:events');
const { PROJECT_ROOT } = require('../src/paths.cjs');

test('仅复制发布清单也能从稳定入口启动并提供网页，不依赖旧根目录源码', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-layout-'));
  let child, closed;
  t.after(async () => {
    if (child) {
      child.kill();
      await closed;
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const files = require('../release-files.json');
  for (const file of files) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(PROJECT_ROOT, file), target);
  }
  for (const name of ['smol-toml', 'yaml'])
    fs.cpSync(
      path.join(PROJECT_ROOT, 'node_modules', name),
      path.join(root, 'node_modules', name),
      { recursive: true },
    );
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const home = path.join(root, 'codex');
  fs.mkdirSync(home);
  const config = 'model="layout-fixture"\n';
  fs.writeFileSync(path.join(home, 'config.toml'), config);
  child = spawn(process.execPath, [path.join(root, 'main.cjs'), '--no-open'], {
    cwd: root,
    env: {
      ...process.env,
      BRIDGE_HOME: path.join(root, 'private'),
      BRIDGE_CODEX_HOME: home,
      BRIDGE_HERMES_HOME: path.join(root, 'no-hermes'),
      BRIDGE_DISCOVERY_DIR: path.join(root, 'discovery'),
      BRIDGE_PORT: String(port),
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  closed = once(child, 'close');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('隔离发布入口启动超时')), 15000);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('BRIDGE_READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(Error('入口退出：' + code));
    });
  });
  const base = 'http://127.0.0.1:' + port;
  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Codex/);
  const script = await fetch(base + '/app.js');
  assert.equal(script.status, 200);
  assert.match(await script.text(), /renderAccounts/);
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), config);
  assert.equal(fs.existsSync(path.join(home, 'auth.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'accounts.cjs')), false);
});
