'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
async function api(f, action, input, status = 200) {
  const response = await f.api(action, input);
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}
async function serve(t, handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const record = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: raw ? JSON.parse(raw) : null,
    };
    requests.push(record);
    response.setHeader('content-type', 'application/json');
    handler(record, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: 'http://127.0.0.1:' + server.address().port, requests };
}
const responseTool = {
  object: 'response',
  status: 'completed',
  output: [{ type: 'function_call', name: 'bridge_ping', call_id: 'c1', arguments: '{"ok":true}' }],
};
const provider = {
  name: 'Fixture',
  apiMode: 'responses',
  apiKey: 'fixture-secret',
  model: 'm',
  models: ['m', 'm2'],
};
const read = (f, relative = 'config.toml') => fs.readFileSync(path.join(f.home, relative), 'utf8');
async function isolatedEditor(t, f) {
  const child = require('node:child_process').spawn(f.environment.CODEX_EXE, ['app-server'], {
    cwd: f.root,
    env: f.environment,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  f.track(child);
  child.stderr.resume();
  const ready = require('node:events').once(child.stdout, 'data');
  child.stdin.write('{"id":1,"method":"initialize","params":{}}\n');
  await ready;
  const clients = path.join(f.bridge, 'clients');
  fs.mkdirSync(clients, { recursive: true });
  fs.writeFileSync(
    path.join(clients, 'fixture-editor.json'),
    JSON.stringify({
      id: 'fixture-editor',
      pid: process.pid,
      home: f.home,
      seenAt: Date.now(),
      waitUntil: Date.now() + 120000,
      companionHost: 'local',
      name: 'Fixture editor',
    }),
  );
  const status = await api(f, 'clients', {});
  assert.ok(status.clients.some((c) => c.pid === child.pid && c.confirmed && c.shared));
  // An actual confirmed fake backend and synthetic parent heartbeat prevent
  // desktop fallback. No test may select, stop or reopen a real client.
  // Node's existing desktop scheduler falls back to the installed desktop
  // when it has no editor. Rust currently queues config-only restore tasks
  // without a desktop scheduler. This is a fixture safety precondition,
  // not an assertion that Rust has implemented batch-4 window association.
  if (!require('./backend.cjs').isRust)
    assert.ok(status.clients.some((c) => c.kind === 'editor' && c.confirmed && c.shared));
  assert.ok(
    status.clients.filter((c) => c.kind === 'desktop').every((c) => c.confirmed && !c.shared),
  );
}
async function finishJob(f) {
  const file = path.join(f.bridge, 'account-switch.json'),
    deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const job = JSON.parse(fs.readFileSync(file));
    if (['done', 'error'].includes(job.status)) {
      assert.equal(job.status, 'done', JSON.stringify(job));
      return job;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail('Isolated restore did not complete: ' + fs.readFileSync(file));
}
function algorithm(t, input) {
  const os = require('node:os'),
    { execFileSync } = require('node:child_process');
  const { isRust, rustBinary } = require('./backend.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-config-algorithm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'input.json'),
    target = path.join(root, 'output.json');
  fs.writeFileSync(source, JSON.stringify(input));
  execFileSync(
    isRust ? rustBinary() : process.execPath,
    isRust
      ? ['--algorithm-fixture', source, target]
      : [path.join(__dirname, 'fixtures/diagnostics-algorithm.cjs'), source, target],
    { windowsHide: true },
  );
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}
async function interfere(t, f, directory, prefix) {
  const target = path.join(f.home, 'config.toml');
  if (process.platform === 'darwin') {
    const { execFileSync, spawn } = require('node:child_process');
    const executable = path.join(f.root, 'config-interference');
    execFileSync('clang', [
      '-O2',
      path.join(__dirname, 'fixtures/config-interference.c'),
      '-o',
      executable,
    ]);
    const marker = path.join(f.root, 'external-edit-completed');
    const child = spawn(executable, [directory, prefix, target, marker], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    f.track(child);
    const ready = await require('node:events').once(child.stdout, 'data');
    assert.equal(String(ready[0]).trim(), 'ready');
    return () => fs.existsSync(marker);
  }
  let changed = false;
  const watcher = fs.watch(directory, (_, name) => {
    if (
      !changed &&
      String(name).startsWith(prefix) &&
      String(name).endsWith('.tmp') &&
      fs.existsSync(path.join(directory, String(name)))
    ) {
      changed = true;
      fs.writeFileSync(target, 'model="external"\n');
    }
  });
  t.after(() => watcher.close());
  return () => changed;
}
module.exports = {
  api,
  serve,
  responseTool,
  provider,
  read,
  isolatedEditor,
  finishJob,
  algorithm,
  interfere,
};
