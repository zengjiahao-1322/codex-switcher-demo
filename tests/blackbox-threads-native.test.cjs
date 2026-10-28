'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { startBackend } = require('./backend-process.cjs');
const { api, isolatedEditor } = require('./config-blackbox-helpers.cjs');
const { auth, accountId, until } = require('./official-blackbox-helpers.cjs');
async function session(f) {
  const args = ['notify=[]', 'analytics.enabled=false', 'features.plugins=false', 'features.remote_plugin=false', 'features.codex_hooks=false'].flatMap(v => ['-c', v]);
  const child = spawn(f.environment.CODEX_EXE, [...args, 'app-server'], { cwd: f.home, env: f.environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let next = 0; const pending = new Map(); const closed = once(child, 'close'); child.stderr.resume();
  const input = require('node:readline').createInterface({ input: child.stdout });
  input.on('line', line => { const response = JSON.parse(line); const item = pending.get(response.id); if (!item) return; pending.delete(response.id); clearTimeout(item.timer); response.error ? item.reject(Error(response.error.message)) : item.resolve(response.result); });
  const call = (method, params) => new Promise((resolve, reject) => { const id = ++next; const timer = setTimeout(() => reject(Error('Native fixture RPC timed out: ' + method)), 20000); pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
  await call('initialize', { clientInfo: { name: 'switcher-blackbox-seed', version: '1' }, capabilities: { experimentalApi: true } });
  return { call, close: async () => { child.stdin.end(); await closed; } };
}
test('真实旧对话HTTP：8条新旧历史切换后冷读持久，消息工具和个别速度保持', { timeout: 120000 }, async t => {
  assert.ok(process.env.CODEX_EXE && fs.existsSync(process.env.CODEX_EXE), 'Use an isolated copy of official Codex');
  const target = auth('target'); const id = accountId('target');
  const f = await startBackend(t, { shortRoot: true, setup({ home, bridge, fake }) {
    fs.copyFileSync(process.env.CODEX_EXE, fake); if (process.platform !== 'win32') fs.chmodSync(fake, 0o755);
    fs.mkdirSync(path.join(bridge, 'accounts', id), { recursive: true });
    fs.writeFileSync(path.join(bridge, 'accounts', 'index.json'), JSON.stringify([{ id, email: 'target@example.test' }]));
    fs.writeFileSync(path.join(bridge, 'accounts', id, 'auth.json'), JSON.stringify(target));
    fs.writeFileSync(path.join(home, 'config.toml'), 'model="gpt-6.1-sol"\n[features]\nplugins=false\n');
  } });
  let client = await session(f); const threads = [];
  try {
    for (let i = 0; i < 8; i++) {
      const { thread } = await client.call('thread/start', { model: 'gpt-6.1-sol', modelProvider: 'openai', cwd: f.root, historyMode: i % 2 ? 'legacy' : 'paginated' });
      await client.call('thread/inject_items', { threadId: thread.id, items: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '保留历史 ' + i }] },
        { type: 'function_call', name: 'shell', call_id: 'kept-call', arguments: '{"command":"echo fixture"}' },
        { type: 'function_call_output', call_id: 'kept-call', output: 'fixture' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '工具结果保留。' }] },
      ] });
      await client.call('thread/settings/update', { threadId: thread.id, serviceTier: i === 0 ? 'priority' : null });
      await client.call('thread/unsubscribe', { threadId: thread.id }); threads.push(thread);
    }
  } finally { await client.close(); }
  const history = thread => fs.readFileSync(thread.path, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(r => r.type === 'response_item');
  const before = threads.map(history);
  const db = new DatabaseSync(path.join(f.home, 'state_5.sqlite'));
  db.prepare('UPDATE threads SET model_provider=? WHERE id=?').run('other', threads[7].id);
  db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(threads[6].id); db.close();
  await isolatedEditor(t, f);
  const selected = 'model="gpt-6.1-sol"\nmodel_provider="openai"\n';
  fs.writeFileSync(path.join(f.home, 'config.toml'), selected);
  await api(f, 'accountSwitch', { id, threadFollow: 'all', reloadEditors: false });
  const job = await until(async () => JSON.parse(fs.readFileSync(path.join(f.bridge, 'account-switch.json'))), s => ['done', 'error'].includes(s.status), 60000);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.threads.failed, 0); assert.equal(job.threads.updated, 1);
  client = await session(f);
  try {
    for (const [i, thread] of threads.entries()) {
      const cold = (await client.call('thread/read', { threadId: thread.id, includeTurns: false })).thread;
      assert.equal(cold.modelProvider, 'openai'); assert.equal(cold.historyMode, thread.historyMode);
      assert.deepEqual(history(thread), before[i]);
    }
  } finally { await client.close(); }
});
