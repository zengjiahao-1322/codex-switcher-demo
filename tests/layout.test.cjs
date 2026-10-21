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

test(
  '同版本新副本替换旧后台，同一构建重复启动复用后台，配置和凭证不变',
  { timeout: 30000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-upgrade-'));
    const children = [];
    const occupied = net.createServer();
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    t.after(() => new Promise((resolve) => occupied.close(resolve)));
    t.after(async () => {
      for (const { child } of children) child.kill();
      await Promise.all(children.map((item) => item.closed));
      assert.equal(path.dirname(root), os.tmpdir());
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const copy = (name) => {
      const app = path.join(root, name);
      for (const file of require('../release-files.json')) {
        fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
        fs.copyFileSync(path.join(PROJECT_ROOT, file), path.join(app, file));
      }
      for (const dep of ['smol-toml', 'yaml'])
        fs.cpSync(
          path.join(PROJECT_ROOT, 'node_modules', dep),
          path.join(app, 'node_modules', dep),
          { recursive: true },
        );
      return app;
    };
    const oldApp = copy('old-app'),
      newApp = copy('new-app'),
      home = path.join(root, 'codex'),
      data = path.join(root, 'private');
    fs.mkdirSync(home);
    const config = 'model="upgrade-fixture"\n',
      auth = '{"fixture":"do-not-change"}\n';
    fs.writeFileSync(path.join(home, 'config.toml'), config);
    fs.writeFileSync(path.join(home, 'auth.json'), auth);
    fs.appendFileSync(path.join(newApp, 'web/index.html'), '\n<!-- new-build-marker -->\n');
    const launch = async (app) => {
      const child = spawn(process.execPath, [path.join(app, 'main.cjs'), '--no-open'], {
        env: {
          ...process.env,
          BRIDGE_HOME: data,
          BRIDGE_CODEX_HOME: home,
          BRIDGE_HERMES_HOME: path.join(root, 'no-hermes'),
          BRIDGE_PORT: String(occupied.address().port),
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const closed = new Promise((resolve) => child.once('close', resolve));
      children.push({ child, closed });
      const kind = await new Promise((resolve, reject) => {
        let out = '',
          errors = '';
        const timer = setTimeout(() => reject(Error('升级启动超时：' + errors)), 15000);
        child.stderr.on('data', (chunk) => {
          errors += chunk;
        });
        child.stdout.on('data', (chunk) => {
          out += chunk;
          if (/BRIDGE_READY|BRIDGE_ALREADY_RUNNING/.test(out)) {
            clearTimeout(timer);
            resolve(out.includes('BRIDGE_ALREADY_RUNNING') ? 'reused' : 'started');
          }
        });
        child.once('error', reject);
        child.once('close', () => {
          clearTimeout(timer);
          reject(Error('升级入口提前退出：' + errors));
        });
      });
      return { child, closed, kind };
    };
    const first = await launch(oldApp);
    const second = await launch(oldApp);
    assert.equal(second.kind, 'reused');
    await second.closed;
    const updated = await launch(newApp);
    assert.equal(updated.kind, 'started', '新构建不能继续复用旧后台');
    await first.closed;
    const running = JSON.parse(fs.readFileSync(path.join(data, 'running.json')));
    assert.equal(running.pid, updated.child.pid);
    assert.match(
      await fetch(new URL(running.url).origin).then((r) => r.text()),
      /new-build-marker/,
    );
    const runtime = await fetch(new URL(running.url).origin + '/api/runtime', {
      headers: { Authorization: 'Bearer ' + new URL(running.url).hash.slice(1) },
    }).then((response) => response.json());
    assert.equal(runtime.id, running.build.id);
    assert.equal(runtime.pid, updated.child.pid);
    // 历史版本没有构建接口或构建字段，也必须能接管到新版，而非永久停在旧页面。
    updated.child.kill();
    await updated.closed;
    const legacyFile = path.join(oldApp, 'src/server/server.cjs');
    const legacySource = fs
      .readFileSync(legacyFile, 'utf8')
      .replace(
        "const url = new URL(req.url, 'http://' + host);",
        "const url = new URL(req.url, 'http://' + host); if(url.pathname==='/api/runtime') return send(404, {error:'legacy'});",
      );
    fs.writeFileSync(legacyFile, legacySource);
    const legacy = await launch(oldApp);
    const legacyRecord = JSON.parse(fs.readFileSync(path.join(data, 'running.json')));
    delete legacyRecord.build;
    fs.writeFileSync(path.join(data, 'running.json'), JSON.stringify(legacyRecord));
    const upgradedLegacy = await launch(newApp);
    assert.equal(upgradedLegacy.kind, 'started');
    await legacy.closed;
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), config);
    assert.equal(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'), auth);
  },
);
