'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { algorithm } = require('./config-blackbox-helpers.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-window-vector-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'),
    bridge = path.join(root, 'bridge');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(bridge, 'clients'), { recursive: true });
  const window = (input) =>
    fs.writeFileSync(
      path.join(bridge, 'clients', input.id + '.json'),
      JSON.stringify({ seenAt: Date.now(), ...input }),
    );
  const snapshot = (inventory) => algorithm(t, { op: 'clientSnapshot', home, bridge, inventory });
  return { root, home, bridge, window, snapshot };
}
test('窗口样例：最近编辑器宿主优先于桌面祖先，两平台路径均保持IDE归属', (t) => {
  const f = fixture(t);
  for (const [exe, name] of [
    ['C:/OpenAI.Codex_fixture/app/Codex.exe', 'Code.exe'],
    ['/Applications/Codex.app/Contents/MacOS/Codex', 'Code Helper (Plugin)'],
  ]) {
    const result = f.snapshot({
      ancestry: [
        { pid: 50, parentPid: 1, exe, name: 'Codex' },
        { pid: 100, parentPid: 50, name },
      ],
      processes: [{ pid: 101, parentPid: 100, exe: 'codex', context: { ok: true, home: f.home } }],
    });
    assert.equal(result.clients[0].kind, 'ide');
    assert.equal(result.clients[0].desktopPid, null);
  }
});
test('窗口样例：同实例共享通信标识时PID优先，模糊匹配不得抢占另一窗口', (t) => {
  const f = fixture(t);
  for (const pid of [810, 820])
    f.window({ id: 'window-' + pid, pid, windowKey: 'shared-hook', home: f.home });
  const inventory = {
    ancestry: [810, 820].map((pid) => ({ pid, parentPid: 1, name: 'Code Helper (Plugin)' })),
    processes: [810, 820].map((parentPid) => ({
      pid: parentPid + 1,
      parentPid,
      exe: '/extensions/openai.chatgpt/bin/codex',
      context: { ok: true, home: f.home, windowKey: 'shared-hook' },
    })),
  };
  const result = f.snapshot(inventory);
  assert.equal(result.clients.find((c) => c.pid === 811).editorId, 'window-810');
  assert.equal(result.clients.find((c) => c.pid === 821).editorId, 'window-820');
  const ambiguous = f.snapshot({
    ...inventory,
    processes: [{ ...inventory.processes[0], parentPid: 999 }],
  });
  assert.equal(ambiguous.clients.find((c) => c.kind === 'ide').editorId, null);
});
test('窗口样例：远程标签和WSL不覆盖已确认本机PID，独立目录不得重载', (t) => {
  const f = fixture(t);
  for (const flags of [{ remote: 'ssh-remote+fixture' }, { wsl: true }]) {
    f.window({ id: 'labelled-window', pid: 810, ...flags });
    const inventory = {
      ancestry: [{ pid: 810, parentPid: 1, name: 'Code' }],
      processes: [{ pid: 811, parentPid: 810, exe: 'codex', context: { ok: true, home: f.home } }],
    };
    assert.equal(f.snapshot(inventory).clients.find((c) => c.kind === 'editor').canReload, true);
    inventory.processes[0].context.home = path.join(f.root, 'independent');
    assert.equal(f.snapshot(inventory).clients.find((c) => c.kind === 'editor').canReload, false);
  }
});
test('窗口样例：远端host按唯一home关联，旧版缺home时拒绝误关联', (t) => {
  const f = fixture(t);
  f.window({
    id: 'remote-home-window',
    pid: 987654,
    remote: 'ssh-remote+fixture',
    companionHost: 'remote',
    home: f.home,
  });
  const inventory = {
    ancestry: [],
    processes: [
      {
        pid: 17632,
        parentPid: 17631,
        exe: '/remote/openai.chatgpt/bin/codex',
        context: { ok: true, home: f.home },
      },
    ],
  };
  assert.equal(f.snapshot(inventory).clients.find((c) => c.kind === 'editor').canReload, true);
  f.window({ id: 'remote-home-window', pid: 987654, remote: 'ssh-remote+fixture', home: null });
  const result = f.snapshot(inventory);
  assert.equal(result.clients.find((c) => c.pid === 17632).editorId, null);
  assert.equal(result.clients.find((c) => c.kind === 'editor').canReload, false);
});
test('窗口样例：空闲桌面壳识别与后端去重，以实际后端目录决定是否共享', (t) => {
  const f = fixture(t);
  for (const exe of [
    'C:/Program Files/WindowsApps/OpenAI.Codex_fixture/app/ChatGPT.exe',
    '/Applications/Codex.app/Contents/MacOS/Codex',
    '/Applications/Codex.app/Contents/MacOS/ChatGPT',
  ]) {
    const shell = { pid: 700, parentPid: 1, exe, context: { ok: true, home: f.home } };
    assert.equal(f.snapshot({ ancestry: [], processes: [shell] }).desktop, true);
    const backend = {
      pid: 701,
      parentPid: 700,
      exe: '/extensions/codex',
      context: { ok: true, home: path.join(f.root, 'independent') },
    };
    const result = f.snapshot({ ancestry: [shell], processes: [shell, backend] });
    assert.equal(result.clients.length, 1);
    assert.equal(result.clients[0].pid, 701);
    assert.equal(result.clients[0].shared, false);
  }
});
test('窗口样例：普通ChatGPT与自动化辅助后台不参与Codex重启', (t) => {
  const f = fixture(t);
  const result = f.snapshot({
    ancestry: [{ pid: 101, parentPid: 1, name: 'node_repl' }],
    processes: [
      { pid: 201, parentPid: 101, exe: 'codex', context: { ok: true, home: f.home } },
      {
        pid: 202,
        parentPid: 1,
        exe: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
        context: { ok: true, home: f.home },
      },
    ],
  });
  assert.equal(result.desktop, false);
  assert.equal(result.auxiliary.length, 1);
  assert.ok(!result.clients.some((c) => c.pid === 201));
});
test('旧对话速度样例：倒读跨块中文，保留最新null或priority而忽略聊天文字', (t) => {
  const f = fixture(t),
    file = path.join(f.root, 'history.jsonl');
  const setting = (tier) =>
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_settings: { service_tier: tier, note: '中文'.repeat(22000) },
      },
    });
  fs.writeFileSync(
    file,
    setting('priority') +
      '\n' +
      setting(null) +
      '\n' +
      JSON.stringify({ type: 'response_item', payload: { text: 'thread_settings_applied' } }),
  );
  assert.deepEqual(algorithm(t, { op: 'serviceTier', file }), { tier: null });
  fs.writeFileSync(file, setting('priority'));
  assert.deepEqual(algorithm(t, { op: 'serviceTier', file }), { tier: 'priority' });
  fs.writeFileSync(file, '{}\n');
  assert.equal(algorithm(t, { op: 'serviceTier', file }), null);
});
