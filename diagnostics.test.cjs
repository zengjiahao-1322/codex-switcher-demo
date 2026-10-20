'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  { DatabaseSync } = require('node:sqlite');
const { listThreads, diagnose, exportContext } = require('./diagnostics.cjs'),
  { writeJson } = require('./accounts.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-diagnosis-')),
    home = path.join(root, 'home'),
    bridge = path.join(root, 'bridge');
  fs.mkdirSync(home);
  fs.mkdirSync(bridge);
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    'model="api-model"\nmodel_provider="hermes_bridge"\n[model_providers.hermes_bridge]\nbase_url="http://localhost:1/v1"\nrequires_openai_auth=false\n',
  );
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.exec(
    'CREATE TABLE threads (id TEXT PRIMARY KEY,title TEXT,updated_at INTEGER,model TEXT,model_provider TEXT,archived INTEGER,source TEXT,rollout_path TEXT,cwd TEXT,creator_account_id TEXT,creator_user_id TEXT)',
  );
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, bridge, db };
}
function session(f, id, provider, items = []) {
  const file = path.join(f.home, id + '.jsonl');
  fs.writeFileSync(file, items.map((x) => JSON.stringify(x)).join('\n') + '\n');
  f.db
    .prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, '会话 ' + id, 1, 'old-model', provider, 0, 'vscode', file, f.root, null, null);
  return file;
}
test('specific diagnosis distinguishes missing provider, official identity and correlated encrypted error', async (t) => {
  const f = fixture(t),
    file = session(f, 'old', 'removed-provider', [
      {
        type: 'event_msg',
        timestamp: '2026-01-01T00:00:00Z',
        payload: { type: 'error', message: 'invalid_encrypted_content' },
      },
    ]);
  const before = fs.readFileSync(file);
  const logs = new DatabaseSync(path.join(f.home, 'logs_2.sqlite'));
  logs.exec(
    'CREATE TABLE logs (id INTEGER,ts INTEGER,level TEXT,thread_id TEXT,feedback_log_body TEXT)',
  );
  logs
    .prepare('INSERT INTO logs VALUES (1,1,?,?,?)')
    .run('ERROR', 'old', '401 unauthorized secret-should-not-return');
  logs.close();
  const r = await diagnose({ codexHome: f.home, bridgeHome: f.bridge, id: 'old' });
  assert.ok(r.findings.some((x) => /供应商没有定义/.test(x.title)));
  assert.ok(r.findings.some((x) => /加密内容/.test(x.title)));
  assert.ok(r.findings.some((x) => /鉴权失败/.test(x.title)));
  assert.equal(JSON.stringify(r).includes('secret-should-not-return'), false);
  assert.deepEqual(fs.readFileSync(file), before);
  session(f, 'official', 'openai');
  const official = await diagnose({ codexHome: f.home, bridgeHome: f.bridge, id: 'official' });
  assert.ok(official.actions.some((x) => x.type === 'reapply'));
  assert.equal(listThreads(f.home, { query: 'official' }).items.length, 1);
});

test('editor reload failure stays visible after the request was acknowledged', (t) => {
  const f = fixture(t);
  const clients = require('./client-status.cjs');
  const identity = { id: 'editor-reload-failed', pid: 123, home: f.home };
  clients.heartbeat(f.bridge, identity);
  const file = path.join(f.bridge, 'clients', identity.id + '.json');
  const row = JSON.parse(fs.readFileSync(file, 'utf8'));
  writeJson(file, { ...row, command: { id: 'request-123', type: 'reload' } });
  clients.heartbeat(f.bridge, { ...identity, ack: 'request-123', ackStatus: 'reload_requested' });
  clients.heartbeat(f.bridge, {
    ...identity,
    ack: 'request-123',
    ackStatus: 'reload_failed',
    ackError: 'window command failed',
  });
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(result.command, null);
  assert.equal(result.lastAck.status, 'reload_failed');
  assert.equal(result.lastAck.error, 'window command failed');
});
test('context export preserves repeated visible messages and omits hidden reasoning and tools', async (t) => {
  const f = fixture(t),
    visible = (role, text, channel) => ({
      type: 'response_item',
      payload: {
        type: 'message',
        role,
        channel,
        content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
      },
    });
  const file = session(f, 'export', 'hermes_bridge', [
    visible('user', 'repeat'),
    visible('assistant', 'visible'),
    visible('user', 'repeat'),
    visible('assistant', 'HIDDEN_ANALYSIS', 'analysis'),
    {
      type: 'response_item',
      payload: { type: 'reasoning', encrypted_content: 'HIDDEN_ENCRYPTED' },
    },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'TOOL_SECRET' } },
  ]);
  const before = fs.readFileSync(file);
  const result = await exportContext(f.home, f.bridge, 'export'),
    text = fs.readFileSync(result.file, 'utf8');
  assert.equal(result.messages, 3);
  assert.equal(text.match(/repeat/g).length, 2);
  assert.match(text, /visible/);
  assert.doesNotMatch(text, /HIDDEN|TOOL_SECRET/);
  assert.deepEqual(fs.readFileSync(file), before);
});
test('window registry reloads only confirmed shared-home editor and records acknowledgement', (t) => {
  const f = fixture(t),
    c = require('./client-status.cjs'),
    other = path.join(f.root, 'other');
  fs.mkdirSync(other);
  c.heartbeat(f.bridge, { id: 'editor-shared', pid: 100, name: 'VS Code', home: f.home });
  c.heartbeat(f.bridge, { id: 'editor-other', pid: 200, name: 'VS Code', home: other });
  const inventory = {
    ancestry: [
      { pid: 100, parentPid: 1, name: 'Code.exe' },
      { pid: 200, parentPid: 2, name: 'Code.exe' },
    ],
    processes: [
      {
        pid: 101,
        parentPid: 100,
        exe: 'codex.exe',
        startedAt: new Date().toISOString(),
        context: { ok: true, home: f.home, cwd: f.root, overrides: {} },
      },
      {
        pid: 201,
        parentPid: 200,
        exe: 'codex.exe',
        startedAt: new Date().toISOString(),
        context: { ok: true, home: other, cwd: f.root, overrides: {} },
      },
    ],
  };
  const status = c.snapshot(f.home, f.bridge, { inventory }),
    editors = status.clients.filter((x) => x.kind === 'editor');
  assert.equal(editors.find((x) => x.editorId === 'editor-shared').canReload, true);
  assert.equal(editors.find((x) => x.editorId === 'editor-other').canReload, false);
  const request = { id: 'reload-1', type: 'reload' };
  const file = path.join(f.bridge, 'clients', 'editor-shared.json'),
    row = JSON.parse(fs.readFileSync(file));
  writeJson(file, { ...row, command: request });
  assert.equal(c.heartbeat(f.bridge, { id: 'editor-shared', pid: 100 }).command.id, 'reload-1');
  c.heartbeat(f.bridge, { id: 'editor-shared', pid: 100, ack: 'reload-1' });
  assert.equal(JSON.parse(fs.readFileSync(file)).command, null);
});
