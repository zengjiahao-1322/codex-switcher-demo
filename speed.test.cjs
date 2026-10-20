'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const toml = require('smol-toml');
const core = require('./core.cjs');

test('Fast 检测区分请求通过、上游回报与实际提速，不用 default 判定失败', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-fast-probe-'));
  const home = path.join(root, 'home'),
    bridge = path.join(root, 'bridge');
  fs.mkdirSync(home);
  fs.mkdirSync(bridge);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model="fixture"\n');
  let tier = 'default';
  let nativeOnly = false;
  let rejectFast = false;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(payload.service_tier, 'priority');
    res.setHeader('Content-Type', 'application/json');
    if (rejectFast || (nativeOnly && req.url.endsWith('/responses'))) {
      res.writeHead(rejectFast ? 400 : 404);
      res.end('{}');
      return;
    }
    res.end(
      JSON.stringify({
        object: 'response',
        status: 'completed',
        ...(tier ? { service_tier: tier } : {}),
        output: [{ type: 'function_call', name: 'bridge_ping', arguments: '{"ok":true}' }],
        ...(nativeOnly
          ? {
              choices: [
                {
                  message: {
                    tool_calls: [{ function: { name: 'bridge_ping', arguments: '{"ok":true}' } }],
                  },
                },
              ],
            }
          : {}),
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const service = require('./service.cjs').createService({ codexHome: home, bridgeHome: bridge });
  const id = require('./providers.cjs').add(bridge, {
    name: 'Fast probe fixture',
    baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1',
    apiMode: 'responses',
    model: 'fixture',
    apiKey: 'fixture',
  });
  for (nativeOnly of [false, true]) {
    for (tier of ['priority', 'fast', 'default', 'auto', null]) {
      const result = await service.actions.probe({ id, model: 'fixture', fast: true });
      assert.equal(result.ok, true);
      assert.equal(result.mode, nativeOnly ? 'adapter' : 'direct');
      assert.equal(result.fastRequestAccepted, true);
      assert.equal(result.requestedServiceTier, 'priority');
      assert.equal(result.accelerationStatus, 'unverified');
      assert.equal(Object.hasOwn(result, 'fastConfirmed'), false);
      assert.equal(result.serviceTier, tier);
      assert.match(result.message, tier ? new RegExp('上游回报 ' + tier) : /上游未回报/);
      assert.match(result.message, /Fast 请求通过/);
      assert.match(result.message, /实际提速未验证/);
      if (tier === 'default' || tier === 'auto')
        assert.match(result.message, /不能用于判定 Fast 失败/);
    }
  }
  const store = require('./providers.cjs');
  const priorAccess = store.access(
    bridge,
    store.list(bridge).find((p) => p.id === id),
  );
  rejectFast = true;
  const rejected = await service.actions.probe({ id, model: 'fixture', fast: true });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.fastRequestAccepted, false);
  assert.equal(rejected.accelerationStatus, 'unverified');
  assert.equal(Object.hasOwn(rejected, 'fastConfirmed'), false);
  assert.deepEqual(
    store.access(
      bridge,
      store.list(bridge).find((p) => p.id === id),
    ),
    priorAccess,
  );
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), 'model="fixture"\n');
});

test('切换来源保留 Codex 的速度、推理强度、MCP 和其他功能设置', () => {
  for (const features of [
    '[features]\nfast_mode=false\nplugins=false\n',
    'features = { fast_mode=false, plugins=false }\n',
    'features.fast_mode=false\nfeatures.plugins=false\n',
  ]) {
    const original =
      '# retained\nmodel="gpt-6.1-sol"\nmodel_reasoning_effort="high"\n' +
      features +
      '[mcp_servers.keep]\ncommand="keep" # retained MCP\n';
    const configured = 'service_tier="fast"\n' + original;
    const next = core.prepareConfig(
      configured,
      { name: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture' },
      'gpt-6.1-sol',
    );
    const parsed = toml.parse(next);
    assert.equal(parsed.service_tier, 'fast');
    assert.equal(parsed.features.fast_mode, false);
    assert.equal(parsed.features.plugins, false);
    assert.equal(parsed.model, 'gpt-6.1-sol');
    assert.equal(parsed.model_reasoning_effort, 'high');
    assert.ok(next.includes('command="keep" # retained MCP'));
  }
});

test(
  '真实 Codex 会话内切换 Fast 后下一轮生效，不重启或改写全局配置',
  { timeout: 60000 },
  async (t) => {
    const root = fs.mkdtempSync(
      path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'switcher-fast-'),
    );
    const requests = [];
    const upstream = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const item = {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'FAST_FIXTURE_OK', annotations: [] }],
      };
      const response = {
        id: 'resp_fixture',
        object: 'response',
        status: 'completed',
        model: 'gpt-6.1-sol',
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { ...item, status: 'in_progress', content: [] },
        },
        {
          type: 'response.output_text.delta',
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: 'FAST_FIXTURE_OK',
        },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ])
        res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
      res.end();
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      await new Promise((resolve) => {
        upstream.close(resolve);
        upstream.closeAllConnections();
      });
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const provider = {
      name: 'Fast fixture',
      baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1',
      apiKey: 'fixture-key',
    };
    // 旧版曾写入 Fast 默认值，原生会话仍应能即时关闭，不要求重新应用来源。
    const config = core.prepareConfig('service_tier="fast"\n', provider, 'gpt-6.1-sol');
    const configFile = path.join(root, 'config.toml');
    fs.writeFileSync(configFile, config);
    let finish;
    const { openSession } = require('./thread-routing.cjs');
    const client = openSession(root, root, {}, (notification) => {
      if (notification.method === 'turn/completed') finish?.(notification.params.turn);
    });
    try {
      await client.call('initialize', {
        clientInfo: { name: 'native-fast-toggle-test', version: '1' },
        capabilities: { experimentalApi: true },
      });
      const models = await client.call('model/list', {});
      assert.ok(
        models.data
          .find((m) => m.model === 'gpt-6.1-sol')
          ?.serviceTiers.some((tier) => tier.id === 'priority'),
        '原生模型目录应提供 Fast 速度选项',
      );
      const { thread } = await client.call('thread/start', { cwd: root, model: 'gpt-6.1-sol' });
      for (const fast of [true, false]) {
        await client.call('thread/settings/update', {
          threadId: thread.id,
          serviceTier: fast ? 'priority' : null,
        });
        let timer;
        const done = new Promise((resolve, reject) => {
          finish = resolve;
          timer = setTimeout(() => reject(Error('Native turn timed out')), 20000);
        });
        try {
          await client.call('turn/start', {
            threadId: thread.id,
            input: [{ type: 'text', text: 'Reply FAST_FIXTURE_OK only.' }],
          });
          const turn = await done;
          assert.equal(turn.status, 'completed');
        } finally {
          clearTimeout(timer);
        }
        assert.equal(requests.at(-1).service_tier, fast ? 'priority' : undefined);
        assert.equal(requests.at(-1).model, 'gpt-6.1-sol');
        assert.equal(fs.readFileSync(configFile, 'utf8'), config);
      }
    } finally {
      await client.close();
    }
    assert.equal(requests.length, 2);
  },
);
