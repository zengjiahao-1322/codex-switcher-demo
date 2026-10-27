'use strict';

const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  cp = require('node:child_process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-performance-')),
    codexHome = path.join(root, 'codex'),
    bridgeHome = path.join(root, 'bridge');
  fs.mkdirSync(codexHome);
  fs.mkdirSync(bridgeHome);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model="fixture"\n');
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, codexHome, bridgeHome };
}
function inventory(home) {
  return {
    ancestry: [{ pid: 710, parentPid: 1, name: 'Code.exe' }],
    processes: [
      {
        pid: 711,
        parentPid: 710,
        exe: '/extensions/openai.chatgpt-test/bin/codex',
        context: { ok: true, home },
      },
    ],
  };
}

test('已接入窗口十秒内十次心跳只扫描一次，PID 改变和重载确认立即重查', async (t) => {
  const f = fixture(t),
    clients = require('../src/clients/client-status.cjs'),
    current = inventory(f.codexHome),
    options = [];
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(clients, 'scanAsync', async (input) => {
    options.push(input);
    return current;
  });
  const service = require('../src/server/service.cjs').createService(f),
    input = { id: 'ready-window', pid: 710 };
  for (let i = 0; i < 10; i++) {
    assert.equal((await service.actions.clientHeartbeat(input)).connection.state, 'ready');
    now += 1000;
  }
  assert.equal(options.length, 1);
  current.ancestry[0].pid = 720;
  current.processes[0].parentPid = input.pid = 720;
  await service.actions.clientHeartbeat(input);
  assert.equal(options.length, 2);
  await service.actions.clientHeartbeat({
    ...input,
    completedReload: { clientId: 'previous-window', commandId: 'fixture-command' },
  });
  assert.equal(options.length, 3);
  assert.equal(options.at(-1).force, true);
});

test('未关联五秒后重查，接入状态不定时扫描，管理目录改变后立即重新判断', async (t) => {
  const f = fixture(t),
    clients = require('../src/clients/client-status.cjs'),
    current = inventory(f.codexHome),
    processRow = current.processes.pop();
  let scans = 0,
    now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(clients, 'scanAsync', async () => {
    scans++;
    return current;
  });
  const service = require('../src/server/service.cjs').createService(f),
    input = { id: 'waiting-window', pid: 710 };
  assert.equal((await service.actions.clientHeartbeat(input)).connection.state, 'unmatched');
  current.processes.push(processRow);
  now += 4999;
  assert.equal((await service.actions.clientHeartbeat(input)).connection.state, 'unmatched');
  assert.equal(scans, 1);
  now++;
  assert.equal((await service.actions.clientHeartbeat(input)).connection.state, 'ready');
  assert.equal(scans, 2);
  now += 29999;
  await service.actions.clientHeartbeat(input);
  assert.equal(scans, 2);
  now++;
  await service.actions.clientHeartbeat(input);
  assert.equal(scans, 2);
  const other = path.join(f.root, 'other');
  fs.mkdirSync(other);
  await service.actions.setEnvironment({ home: other });
  const changed = await service.actions.clientHeartbeat(input);
  assert.equal(scans, 3);
  assert.equal(changed.connection.home, other);
  assert.equal(changed.connection.state, 'separate');
});

test('三个未关联窗口错峰心跳十秒，真正的非强制进程扫描不超过四次', async (t) => {
  const f = fixture(t),
    clients = require('../src/clients/client-status.cjs'),
    pids = [710, 720, 730],
    current = {
      ancestry: pids.map((pid) => ({ pid, parentPid: 1, name: 'Code', exe: '/bin/Code' })),
      processes: [],
    };
  let now = Date.now(),
    scans = 0;
  t.mock.method(Date, 'now', () => now);
  // 保留真正的 scanAsync 缓存逻辑，只替换外部进程，统计实际扫描而非函数调用。
  t.mock.method(cp, 'execFile', (file, args, options, callback) => {
    assert.ok(file === '/bin/ps' || path.basename(file) === 'process-context.exe');
    scans++;
    const stdout =
      file === '/bin/ps'
        ? pids.map((pid) => pid + ' 1 00:10 /bin/Code').join('\n')
        : JSON.stringify(current);
    queueMicrotask(() => callback(null, stdout, ''));
  });
  await clients.scanAsync({ force: true });
  scans = 0;
  now += 3000;
  const service = require('../src/server/service.cjs').createService(f);
  for (let second = 0; second < 10; second++) {
    const index = second % pids.length;
    const result = await service.actions.clientHeartbeat({
      id: 'staggered-window-' + index,
      pid: pids[index],
    });
    assert.equal(result.connection.state, 'unmatched');
    now += 1000;
  }
  assert.ok(scans > 0 && scans <= 4, '实际扫描次数：' + scans);
});

test('不变心跳五秒内不写文件，重载命令立即可读，接收及失败回报立即落盘', (t) => {
  const { bridgeHome } = fixture(t),
    clients = require('../src/clients/client-status.cjs'),
    input = { id: 'disk-window', pid: 710 },
    file = path.join(bridgeHome, 'clients', input.id + '.json'),
    rename = fs.renameSync;
  let writes = 0,
    now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file) writes++;
    return rename(from, to);
  });
  clients.heartbeat(bridgeHome, input);
  const first = fs.readFileSync(file, 'utf8');
  for (let i = 0; i < 4; i++) {
    now += 1000;
    clients.heartbeat(bridgeHome, input);
  }
  assert.equal(writes, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  now += 1000;
  clients.heartbeat(bridgeHome, input);
  assert.equal(writes, 2);
  assert.equal(JSON.parse(fs.readFileSync(file)).seenAt, now);
  const row = JSON.parse(fs.readFileSync(file));
  row.command = { id: 'reload-fixture', type: 'reload' };
  fs.writeFileSync(file, JSON.stringify(row));
  assert.equal(clients.heartbeat(bridgeHome, input).command.id, row.command.id);
  assert.equal(writes, 2);
  const ack = { ...input, ack: row.command.id, ackStatus: 'reload_requested' };
  clients.heartbeat(bridgeHome, ack);
  assert.equal(writes, 3);
  assert.equal(JSON.parse(fs.readFileSync(file)).lastAck.status, 'reload_requested');
  clients.heartbeat(bridgeHome, ack);
  assert.equal(writes, 3, '相同确认不重复写入');
  clients.heartbeat(bridgeHome, {
    ...ack,
    ackStatus: 'reload_failed',
    ackError: 'fixture failure',
  });
  assert.equal(writes, 4);
  const target = [{ id: input.id, commandId: row.command.id }];
  assert.equal(clients.reloadResults(bridgeHome, target)[0].status, 'failed');
});

test('成功保护过的目录不重复收紧，路径变化时重做，失败时不留下成功标记', (t) => {
  const f = fixture(t),
    core = require('../src/config/core.cjs');
  let protections = 0,
    resets = 0,
    fail = false;
  t.mock.method(core, 'privateAcl', () => {
    protections++;
    if (fail) throw Error('fixture permission denied');
  });
  t.mock.method(cp, 'execFileSync', () => {
    resets++;
  });
  const { protectDataDirs } = require('../src/platform/data-protection.cjs'),
    marker = path.join(f.bridgeHome, 'acl-protected.json');
  fs.writeFileSync(path.join(f.bridgeHome, 'auth.json'), 'fixture');
  assert.equal(protectDataDirs([f.bridgeHome]).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(marker)).path, path.resolve(f.bridgeHome));
  assert.equal(protections, 1);
  assert.equal(protectDataDirs([f.bridgeHome]).ok, true);
  assert.equal(protections, 1);
  assert.equal(resets, process.platform === 'win32' ? 1 : 0);
  const moved = path.join(f.root, 'moved');
  fs.mkdirSync(moved);
  fs.copyFileSync(marker, path.join(moved, 'acl-protected.json'));
  assert.equal(protectDataDirs([moved]).ok, true);
  assert.equal(protections, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(moved, 'acl-protected.json'))).path, moved);
  const denied = path.join(f.root, 'denied');
  fail = true;
  const failed = protectDataDirs([denied]);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /fixture permission denied/);
  assert.equal(fs.existsSync(path.join(denied, 'acl-protected.json')), false);
});

test('Mac 异步扫描让出事件循环，各个原生助手同时在途，并保留具体读取失败', async (t) => {
  const { codexHome } = fixture(t),
    exists = fs.existsSync,
    callbacks = new Map();
  let psCallback;
  t.mock.method(
    fs,
    'existsSync',
    (file) => path.basename(file) === 'mac-process-context' || exists(file),
  );
  t.mock.method(cp, 'execFileSync', () => assert.fail('异步路径不应调用 execFileSync'));
  t.mock.method(cp, 'execFile', (file, args, options, callback) => {
    if (file === '/bin/ps') psCallback = callback;
    else callbacks.set(Number(args[0]), callback);
  });
  const task = require('../src/platform/mac-processes.cjs').scanAsync();
  let ticked = false;
  await new Promise((resolve) =>
    setImmediate(() => {
      ticked = true;
      resolve();
    }),
  );
  assert.equal(ticked, true);
  psCallback(
    null,
    '711 710 00:10 /extensions/codex\n712 710 1-02:03:04 /other/codex\n713 1 00:10 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n',
  );
  await new Promise(setImmediate);
  assert.deepEqual([...callbacks.keys()], [711, 712]);
  callbacks.get(712)(Object.assign(Error('denied'), { code: 'EACCES' }));
  callbacks.get(711)(null, JSON.stringify({ ok: true, home: codexHome }));
  const result = await task;
  assert.equal(result.ancestry.length, 3);
  assert.equal(result.processes.length, 2);
  assert.equal(result.processes[0].context.home, codexHome);
  assert.equal(result.processes[1].context.error, 'process_helper_not_executable');
});
