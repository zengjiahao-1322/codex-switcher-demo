'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');

test('退出清理运行记录和共用发现记录；有切换任务时拒绝', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-lifecycle-')),
    bridge = path.join(root, 'bridge'),
    discovery = path.join(root, 'discovery');
  fs.mkdirSync(bridge);
  fs.mkdirSync(discovery);
  fs.writeFileSync(path.join(bridge, 'running.json'), JSON.stringify({ pid: process.pid }));
  fs.writeFileSync(path.join(discovery, 'connection.json'), JSON.stringify({ pid: process.pid }));
  let stopped = false;
  const lifecycle = require('../src/platform/app-lifecycle.cjs').createLifecycle({
    projectDir: root,
    bridgeHome: bridge,
    codexHome: path.join(root, 'codex'),
    discoveryDir: discovery,
    shutdown: () => {
      stopped = true;
    },
  });
  assert.deepEqual(lifecycle.quit(), { message: '切换器已退出' });
  return new Promise((resolve) =>
    setTimeout(() => {
      assert.equal(stopped, true);
      assert.equal(fs.existsSync(path.join(bridge, 'running.json')), false);
      assert.equal(fs.existsSync(path.join(discovery, 'connection.json')), false);
      fs.rmSync(root, { recursive: true, force: true });
      resolve();
    }, 250),
  );
});

test('多版本交接保留新版本，旧版本才退出', () => {
  const { otherInstallAction } = require('../src/platform/app-lifecycle.cjs');
  assert.equal(otherInstallAction(114, 114), 'deferred');
  assert.equal(otherInstallAction(115, 114), 'deferred');
  assert.equal(otherInstallAction(113, 114), 'stopped');
});

test('桌面整合使用异步进程，不同步阻塞调用方', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-shortcut-')),
    calls = [];
  const result = await require('../src/platform/app-lifecycle.cjs').integrateDesktop(
    root,
    path.join(root, 'discovery'),
    path.join(root, 'bridge'),
    {
      execute: (_exe, args, _options, callback) => {
        calls.push(args);
        setImmediate(() => callback(null, '{"shortcutChanged":false}'));
      },
    },
  );
  assert.equal(result.shortcutChanged, false);
  assert.equal(calls.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});
