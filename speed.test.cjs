'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const toml = require('smol-toml');
const core = require('./core.cjs');

test('Fast 检测区分上游返回加速、标准和未回报，不把 HTTP 成功当成加速成功', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-fast-probe-'));
  const home = path.join(root, 'home'),
    bridge = path.join(root, 'bridge');
  fs.mkdirSync(home);
  fs.mkdirSync(bridge);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model="fixture"\n');
  let tier = 'default';
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(payload.service_tier, 'priority');
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        object: 'response',
        status: 'completed',
        ...(tier ? { service_tier: tier } : {}),
        output: [{ type: 'function_call', name: 'bridge_ping', arguments: '{"ok":true}' }],
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
  for (tier of ['priority', 'default', null]) {
    const result = await service.actions.probe({ id, model: 'fixture', fast: true });
    assert.equal(result.ok, true);
    assert.equal(result.fastConfirmed, tier === 'priority');
    assert.equal(result.serviceTier, tier);
    assert.match(
      result.message,
      tier === 'priority'
        ? /上游回报 Fast/
        : tier === 'default'
          ? /上游回报 default/
          : /上游未回报/,
    );
  }
  const unsupported = require('./providers.cjs').add(bridge, {
    name: 'Anthropic fixture',
    baseUrl: 'http://127.0.0.1:1',
    apiMode: 'anthropic_messages',
    model: 'fixture',
    apiKey: 'fixture',
  });
  const before = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  await assert.rejects(
    service.prepareApi({ id: unsupported, model: 'fixture', fast: true }),
    /不支持 Codex Fast/,
  );
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), before);
});

test('Fast 配置兼容功能表写法，保留模型、推理强度、MCP 和其他功能', () => {
  for (const features of [
    '[features]\nfast_mode=false\nplugins=false\n',
    'features = { fast_mode=false, plugins=false }\n',
    'features.fast_mode=false\nfeatures.plugins=false\n',
  ]) {
    const original =
      '# retained\nmodel="gpt-6.1-sol"\nmodel_reasoning_effort="high"\n' +
      features +
      '[mcp_servers.keep]\ncommand="keep" # retained MCP\n';
    const fast = core.configureSpeed(original, true);
    const parsed = toml.parse(fast);
    assert.equal(parsed.service_tier, 'fast');
    assert.equal(parsed.features.fast_mode, true);
    assert.equal(parsed.features.plugins, false);
    assert.equal(parsed.model, 'gpt-6.1-sol');
    assert.equal(parsed.model_reasoning_effort, 'high');
    assert.ok(fast.includes('command="keep" # retained MCP'));
    assert.equal(toml.parse(core.configureSpeed(fast, false)).service_tier, 'default');
    assert.equal(core.configureSpeed(original, undefined), original);
  }
});

test(
  '真实 Codex 开启 Fast 时发送 priority，关闭后不再发送加速档位',
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
    for (const fast of [true, false]) {
      fs.writeFileSync(
        path.join(root, 'config.toml'),
        core.prepareConfig('', provider, 'gpt-6.1-sol', undefined, fast),
      );
      const reply = path.join(root, 'reply.txt');
      await new Promise((resolve, reject) => {
        const child = execFile(
          require('./runtime.cjs').findCodex(),
          [
            'exec',
            '--skip-git-repo-check',
            '--sandbox',
            'read-only',
            '--output-last-message',
            reply,
            'Reply FAST_FIXTURE_OK only.',
          ],
          {
            cwd: root,
            env: require('./platform.cjs').codexEnv(root),
            windowsHide: true,
            timeout: 20000,
          },
          (error, stdout, stderr) =>
            error
              ? reject(
                  Error(
                    'Native Codex fixture failed: ' +
                      error.code +
                      '; requests=' +
                      requests.length +
                      '; ' +
                      stderr.slice(-2000),
                  ),
                )
              : resolve(),
        );
        child.stdin.end();
      });
      assert.equal(fs.readFileSync(reply, 'utf8').trim(), 'FAST_FIXTURE_OK');
      assert.equal(requests.at(-1).service_tier, fast ? 'priority' : undefined);
      assert.equal(requests.at(-1).model, 'gpt-6.1-sol');
    }
    assert.equal(requests.length, 2);
  },
);
