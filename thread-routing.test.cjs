'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const toml = require('smol-toml');
const { DatabaseSync } = require('node:sqlite');
const { synchronizeThreads, pendingThreads, openSession } = require('./thread-routing.cjs');

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
      for (const historyMode of ['legacy', 'paginated']) {
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
    assert.equal(pendingThreads(home, 'hermes_bridge', 'gpt-6.1-sol').length, 1);
    db.prepare('UPDATE threads SET archived=0,source=? WHERE id=?').run(
      '{"subagent":{"other":"fixture"}}',
      threads[0].id,
    );
    assert.equal(pendingThreads(home, 'hermes_bridge', 'gpt-6.1-sol').length, 1);
    db.prepare('UPDATE threads SET source=? WHERE id=?').run(original, threads[0].id);
    db.close();
    fs.writeFileSync(path.join(home, 'config.toml'), 'model_provider="hermes_bridge"\n' + text);
    const r = await synchronizeThreads({ codexHome: home, bridgeHome: bridge });
    assert.equal(r.count, 2);
    assert.equal(pendingThreads(home, 'hermes_bridge', 'gpt-6.1-sol').length, 0);
    for (const [index, thread] of threads.entries())
      assert.deepEqual(stored(thread), before[index]);
    // 再次切换为空操作；反向切回也走同一逻辑，不另建对话。
    assert.equal((await synchronizeThreads({ codexHome: home, bridgeHome: bridge })).count, 0);
    fs.writeFileSync(path.join(home, 'config.toml'), text);
    assert.equal((await synchronizeThreads({ codexHome: home, bridgeHome: bridge })).count, 2);
    c = await connect();
    try {
      for (const [index, thread] of threads.entries()) {
        const cold = (await c.call('thread/read', { threadId: thread.id, includeTurns: false }))
          .thread;
        assert.equal(cold.modelProvider, 'openai');
        // 官方后端会解析 /tmp 链接和 Windows 短路径，比较切换前后的实际目录。
        assert.equal(fs.realpathSync.native(cold.cwd), fs.realpathSync.native(thread.cwd));
        assert.equal(cold.historyMode, thread.historyMode);
        assert.deepEqual(stored(thread), before[index]);
      }
    } finally {
      await c.close();
    }
    assert.equal(fs.existsSync(marker), false, '会话更新不应启动用户的 MCP');
  },
);
