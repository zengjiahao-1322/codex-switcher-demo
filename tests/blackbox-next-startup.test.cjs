const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process');
const { startBackend } = require('./backend-process.cjs');
test('已退出PID的旧连接不请求runtime且existing小于100ms', {}, async (t) => {
  let dead;
  const c = cp.spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
  dead = c.pid;
  await new Promise((r) => c.once('close', r));
  const f = await startBackend(t, {
    setup({ bridge }) {
      fs.writeFileSync(
        path.join(bridge, 'running.json'),
        JSON.stringify({ pid: dead, url: 'http://127.0.0.1:9/#fixture' }),
      );
    },
  });
  const file = path.join(f.bridge, 'logs/switcher.log');
  let event;
  for (let i = 0; i < 100; i++) {
    event =
      fs.existsSync(file) &&
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse)
        .find((v) => v.event === 'startup' && v.pid === f.child.pid);
    if (event) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(event);
  assert.ok(event.phases.existing < 100, JSON.stringify(event.phases));
});
