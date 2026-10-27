'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { isRust, rustBinary } = require('./backend.cjs');
const { startBackend } = require('./backend-process.cjs');

test('双后台样例对：日志脱敏及2MiB轮换保持Node格式', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-log-vector-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'input.json'),
    output = path.join(root, 'output.json');
  const run = (value) => {
    fs.writeFileSync(input, JSON.stringify(value));
    execFileSync(
      isRust ? rustBinary() : process.execPath,
      isRust
        ? ['--algorithm-fixture', input, output]
        : [path.join(__dirname, 'fixtures', 'diagnostics-algorithm.cjs'), input, output],
      { windowsHide: true, stdio: 'pipe' },
    );
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  };
  const value = {
    account: 'fixture@example.test',
    access_token: 'fixture-value',
    nested: [
      'sk-fixture-only',
      'Bearer fixture-secret',
      'https://example.test/?code=fake&state=fake&access_token=fake',
      os.homedir() + '/test',
    ],
  };
  assert.deepEqual(run({ op: 'redact', value }), {
    account: 'fi***@example.test',
    access_token: '[已隐藏]',
    nested: [
      '[已隐藏]',
      'Bearer [已隐藏]',
      'https://example.test/?code=[已隐藏]&state=[已隐藏]&access_token=[已隐藏]',
      '~/test',
    ],
  });
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs);
  const old =
    JSON.stringify({
      t: '2000-01-01T00:00:00.000Z',
      event: 'old',
      padding: 'x'.repeat(2 * 1024 * 1024),
    }) + '\n';
  fs.writeFileSync(path.join(logs, 'switcher.log'), old);
  fs.writeFileSync(
    path.join(logs, 'switcher.log.1'),
    JSON.stringify({ t: '1999-01-01T00:00:00.000Z', event: 'older' }) + '\n',
  );
  fs.writeFileSync(
    path.join(logs, 'switcher.log.2'),
    JSON.stringify({ t: '1998-01-01T00:00:00.000Z', event: 'discarded' }) + '\n',
  );
  const rows = run({
    op: 'log',
    bridge: root,
    event: 'fixture',
    fields: { apiKey: 'fake-key', account: 'fixture@example.test' },
  });
  assert.deepEqual(
    rows.map((row) => row.event),
    ['older', 'old', 'fixture'],
  );
  assert.equal(rows.at(-1).apiKey, '[已隐藏]');
  assert.equal(rows.at(-1).account, 'fi***@example.test');
  assert.deepEqual(fs.readdirSync(logs).sort(), [
    'switcher.log',
    'switcher.log.1',
    'switcher.log.2',
  ]);
});

test('双后台黑盒：startup/firstRequest日志与诊断导出', async (t) => {
  const f = await startBackend(t);
  const runtime = await (await f.api('runtime')).json();
  await (await f.api('runtime')).text();
  const file = path.join(f.bridge, 'logs', 'switcher.log');
  const rows = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const startup = rows.find((row) => row.event === 'startup');
  assert.ok(startup);
  assert.equal(startup.pid, f.child.pid);
  for (const key of ['existing', 'protectDataDirs', 'createService', 'listen'])
    assert.equal(typeof startup.phases[key], 'number');
  assert.equal(rows.filter((row) => row.event === 'startup.firstRequest').length, 1);
  fs.mkdirSync(path.join(f.bridge, 'clients'), { recursive: true });
  fs.writeFileSync(
    path.join(f.bridge, 'clients', 'remote-fixture.json'),
    JSON.stringify({
      id: 'remote-fixture',
      seenAt: Date.now(),
      authority: 'ssh-remote+fixture-host',
      remote: true,
      companionVersion: '0.1.5',
      remoteAgent: {
        host: 'fixture-host',
        platform: 'linux',
        arch: 'x64',
        codexHome: '/fixture/.codex',
        agentVersion: '0.1.5',
        protocol: 3,
        current: { model: 'fixture-model', modelProvider: 'openai' },
        account: {
          id: 'unknown-fixture',
          email: 'fixture@example.test',
          plan: 'plus',
          lastRefresh: null,
        },
      },
    }),
  );
  const response = await f.api('exportDiagnostics', {});
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.filename, /^codex-switcher-diagnostics-\d{8}-\d{6}\.txt$/);
  const [head, body] = result.text.split('\n---\n');
  const header = JSON.parse(head);
  assert.equal(header.dataDirProtection.ok, true);
  assert.equal(header.proxySource, 'env');
  assert.equal(header.build.id, runtime.id);
  assert.equal(header.remotes[0].host, 'fixture-host');
  assert.equal(header.remotes[0].account.email, 'fi***@example.test');
  assert.equal(header.remotes[0].account.id, null);
  assert.equal(result.text.includes(f.token), false);
  assert.ok(body.includes('startup'));
});

test('双后台黑盒：只读会话索引、错误证据诊断及可见上下文导出', async (t) => {
  const f = await startBackend(t);
  const { DatabaseSync } = require('node:sqlite');
  const databaseFile = path.join(f.home, 'state_5.sqlite');
  const rollout = path.join(f.home, 'session.jsonl');
  fs.writeFileSync(
    rollout,
    [
      { type: 'session_meta', payload: { model_provider: 'missing-fixture' } },
      { type: 'turn_context', payload: { model: 'fixture-model' } },
      {
        type: 'event_msg',
        timestamp: '2026-10-27T00:00:00Z',
        payload: { type: 'error', message: 'invalid_encrypted_content' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '可见用户消息' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          channel: 'analysis',
          content: [{ type: 'output_text', text: '隐藏内容' }],
        },
      },
      { type: 'response_item', payload: { type: 'function_call_output', output: '隐藏工具结果' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          channel: 'final',
          content: [{ type: 'output_text', text: '可见回答' }],
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  const db = new DatabaseSync(databaseFile);
  db.exec(
    'CREATE TABLE threads(id TEXT,title TEXT,updated_at INTEGER,model TEXT,model_provider TEXT,archived INTEGER,source TEXT,rollout_path TEXT,cwd TEXT,creator_account_id TEXT,creator_user_id TEXT)',
  );
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
    'fixture-thread',
    '隔离诊断样例',
    100,
    'fixture-model',
    'missing-fixture',
    0,
    'cli',
    rollout,
    f.root,
    null,
    null,
  );
  db.close();
  const before = fs.readFileSync(databaseFile);
  const listResponse = await f.api('threads', { query: '隔离', limit: 1 });
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].id, 'fixture-thread');
  const diagnose = await f.api('diagnose', { id: 'fixture-thread' });
  assert.equal(diagnose.status, 200);
  const diagnosis = await diagnose.json();
  assert.equal(diagnosis.thread.id, 'fixture-thread');
  assert.ok(diagnosis.findings.some((row) => row.title === '此旧会话的供应商没有定义'));
  assert.ok(diagnosis.findings.some((row) => row.title === '关联错误记录：后端拒绝了历史加密内容'));
  const exported = await f.api('exportContext', { id: 'fixture-thread' });
  assert.equal(exported.status, 200);
  const result = await exported.json();
  assert.equal(result.messages, 2);
  const text = fs.readFileSync(result.file, 'utf8');
  assert.ok(text.includes('可见用户消息') && text.includes('可见回答'));
  assert.equal(text.includes('隐藏内容'), false);
  assert.equal(text.includes('隐藏工具结果'), false);
  assert.deepEqual(fs.readFileSync(databaseFile), before);
});
