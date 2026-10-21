'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const toml = require('smol-toml');
const { DatabaseSync } = require('node:sqlite');
const {
  synchronizeThreads,
  pendingThreads,
  openSession,
  savedServiceTier,
} = require('../src/diagnostics/thread-routing.cjs');

test('倒序读取完整设置行，保留最新默认值和跨块中文，不把聊天文字当设置', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'history.jsonl');
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
  assert.deepEqual(await savedServiceTier(file), { tier: null });
  fs.writeFileSync(file, setting('priority'));
  assert.deepEqual(await savedServiceTier(file), { tier: 'priority' });
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'response_item', payload: { text: 'thread_settings_applied' } }) + '\n',
  );
  assert.equal(await savedServiceTier(file), undefined);
});

test(
  '真实 Codex：新旧两种历史切换来源后冷启动保留，消息和工具记录不变，支持切回官方',
  { timeout: 60000 },
  async (t) => {
    // macOS 临时目录较长，使用短路径给官方后端的本地套接字留出空间。
    const root = fs.mkdtempSync(
      path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'switcher-routing-'),
    );
    const home = path.join(root, 'home'),
      bridge = path.join(root, 'bridge');
    const marker = path.join(root, 'mcp-started');
    fs.mkdirSync(home);
    fs.mkdirSync(bridge);
    t.after(() =>
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    );
    const text =
      'model="gpt-6.1-sol"\n[features]\nplugins=false\n' +
      '[model_providers.hermes_bridge]\nname="fixture"\nbase_url="http://127.0.0.1:1/v1"\n' +
      'wire_api="responses"\nrequires_openai_auth=false\nexperimental_bearer_token="FIXTURE"\n' +
      toml.stringify({
        mcp_servers: {
          node_repl: {
            command: process.execPath,
            args: [
              '-e',
              'require("fs").writeFileSync(' + JSON.stringify(marker) + ',"unexpected")',
            ],
          },
        },
      });
    fs.writeFileSync(path.join(home, 'config.toml'), text);
    const connect = async () => {
      const c = openSession(
        home,
        bridge,
        toml.parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')),
      );
      await c.call('initialize', {
        clientInfo: { name: 'switcher-native-test', version: '1' },
        capabilities: { experimentalApi: true },
      });
      return c;
    };
    let c = await connect();
    const threads = [];
    try {
      for (const historyMode of Array.from({ length: 8 }, (_, i) =>
        i % 2 ? 'legacy' : 'paginated',
      )) {
        const { thread } = await c.call('thread/start', {
          model: 'gpt-6.1-sol',
          modelProvider: 'openai',
          cwd: root,
          historyMode,
        });
        await c.call('thread/inject_items', {
          threadId: thread.id,
          items: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: '需要保留的历史上下文 ' + historyMode }],
            },
            {
              type: 'function_call',
              name: 'shell',
              call_id: 'kept-call',
              arguments: '{"command":"echo HISTORY"}',
            },
            { type: 'function_call_output', call_id: 'kept-call', output: 'HISTORY' },
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '已保留工具执行结果。' }],
            },
          ],
        });
        threads.push(thread);
      }
    } finally {
      await c.close();
    }
    const stored = (thread) =>
      fs
        .readFileSync(thread.path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((row) => row.type === 'response_item');
    const before = threads.map(stored);
    // 归档历史和内部子任务不作为用户正在使用的对话，不被全局切换改写。
    const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    const original = db.prepare('SELECT source FROM threads WHERE id=?').get(threads[0].id).source;
    db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(threads[0].id);
    assert.equal(pendingThreads(home, 'hermes_bridge', 'gpt-6.1-sol').length, 7);
    db.prepare('UPDATE threads SET archived=0,source=? WHERE id=?').run(
      '{"subagent":{"other":"fixture"}}',
      threads[0].id,
    );
    assert.equal(pendingThreads(home, 'hermes_bridge', 'gpt-6.1-sol').length, 7);
    db.prepare('UPDATE threads SET source=? WHERE id=?').run(original, threads[0].id);
    db.close();
    fs.writeFileSync(path.join(home, 'config.toml'), 'model_provider="hermes_bridge"\n' + text);
    const progress = [];
    const r = await synchronizeThreads({
      codexHome: home,
      bridgeHome: bridge,
      onProgress: (item) => progress.push(item),
    });
    assert.equal(r.count, threads.length);
    for (const phase of ['sync', 'verify'])
      assert.deepEqual(
        progress.filter((item) => item.phase === phase).map((item) => item.completed),
        Array.from({ length: 9 }, (_, i) => i),
      );
    assert.equal(pendingThreads(home, 'hermes_bridge', 'gpt-6.1-sol').length, 0);
    for (const [index, thread] of threads.entries())
      assert.deepEqual(stored(thread), before[index]);
    // 再次切换为空操作；反向切回也走同一逻辑，不另建对话。
    assert.equal((await synchronizeThreads({ codexHome: home, bridgeHome: bridge })).count, 0);
    fs.writeFileSync(path.join(home, 'config.toml'), text);
    assert.equal(
      (await synchronizeThreads({ codexHome: home, bridgeHome: bridge })).count,
      threads.length,
    );
    // 两个对话在 Codex 内选择不同速度。切来源时保留各自选择，不统一覆盖。
    c = await connect();
    try {
      for (const [index, thread] of threads.entries()) {
        await c.call('thread/resume', { threadId: thread.id, excludeTurns: true });
        await c.call('thread/settings/update', {
          threadId: thread.id,
          serviceTier: index ? null : 'priority',
        });
        await c.call('thread/unsubscribe', { threadId: thread.id });
      }
    } finally {
      await c.close();
    }
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      'model_provider="hermes_bridge"\nservice_tier="fast"\n' + text,
    );
    assert.equal(
      (await synchronizeThreads({ codexHome: home, bridgeHome: bridge })).count,
      threads.length,
    );
    for (const [index, thread] of threads.entries()) {
      const settings = fs
        .readFileSync(thread.path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((row) => row.payload?.type === 'thread_settings_applied')
        .at(-1).payload.thread_settings;
      assert.equal(settings.service_tier, index ? 'default' : 'priority');
    }
    assert.equal((await synchronizeThreads({ codexHome: home, bridgeHome: bridge })).count, 0);
    c = await connect();
    try {
      for (const [index, thread] of threads.entries()) {
        const cold = (await c.call('thread/read', { threadId: thread.id, includeTurns: false }))
          .thread;
        assert.equal(cold.modelProvider, 'hermes_bridge');
        // 官方后端会解析 /tmp 链接和 Windows 短路径，比较切换前后的实际目录。
        assert.equal(fs.realpathSync.native(cold.cwd), fs.realpathSync.native(thread.cwd));
        assert.equal(cold.historyMode, thread.historyMode);
        assert.deepEqual(stored(thread), before[index]);
      }
    } finally {
      await c.close();
    }
    // 官方配置未指定模型时，解析默认模型后仍应跳过已经匹配的历史。
    fs.writeFileSync(path.join(home, 'config.toml'), text.replace('model="gpt-6.1-sol"\n', ''));
    await synchronizeThreads({ codexHome: home, bridgeHome: bridge });
    assert.equal((await synchronizeThreads({ codexHome: home, bridgeHome: bridge })).count, 0);
    // 并发批次遇到被占用的会话必须报错并回收在途请求，释放后仍可重新同步。
    fs.writeFileSync(path.join(home, 'config.toml'), 'model_provider="hermes_bridge"\n' + text);
    const locked = pendingThreads(home, 'hermes_bridge', 'gpt-6.1-sol')[0];
    c = await connect();
    try {
      await c.call('thread/resume', { threadId: locked.id, excludeTurns: true });
      await assert.rejects(
        synchronizeThreads({ codexHome: home, bridgeHome: bridge }),
        /仍被客户端占用/,
      );
    } finally {
      await c.close();
    }
    await synchronizeThreads({ codexHome: home, bridgeHome: bridge });
    assert.equal(pendingThreads(home, 'hermes_bridge', 'gpt-6.1-sol').length, 0);
    for (const [index, thread] of threads.entries())
      assert.deepEqual(stored(thread), before[index]);
    assert.equal(fs.existsSync(marker), false, '会话更新不应启动用户的 MCP');
  },
);
