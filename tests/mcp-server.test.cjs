const { PROJECT_ROOT } = require('../src/paths.cjs');
// MCP 服务：按协议握手、列工具、调用工具（临时 CODEX_HOME/bridge；直连模拟上游，不启动转换服务）。
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http'),
  { spawn } = require('node:child_process'),
  toml = require('smol-toml');
const testHomes = [];
const makeHome = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-mcp-'));
  testHomes.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of testHomes)
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test(
  'MCP server: initialize, tools/list, list/switch/official/delete via tools/call, never leaks keys',
  { timeout: 120000 },
  async (t) => {
    // 模拟一个支持 Responses 的上游（直连检测通过）。
    const up = http.createServer(async (q, r) => {
      let raw = '';
      for await (const c of q) raw += c;
      r.setHeader('content-type', 'application/json');
      if (q.method === 'GET') {
        r.end(JSON.stringify({ data: [{ id: 'rm' }] }));
        return;
      }
      r.end(
        JSON.stringify({
          object: 'response',
          status: 'completed',
          output: [
            { type: 'function_call', name: 'bridge_ping', call_id: 'c', arguments: '{"ok":true}' },
          ],
        }),
      );
    });
    await new Promise((r) => up.listen(0, '127.0.0.1', r));
    t.after(() => up.close());
    const root = makeHome();
    const codex = path.join(root, 'codex'),
      bridge = path.join(root, 'bridge');
    fs.mkdirSync(codex);
    fs.mkdirSync(bridge);
    fs.writeFileSync(path.join(codex, 'config.toml'), 'model = "gpt-official"\n');
    fs.writeFileSync(
      path.join(codex, 'models_cache.json'),
      JSON.stringify({ models: [{ slug: 'gpt-official', visibility: 'list' }] }),
    );
    fs.writeFileSync(
      path.join(bridge, 'providers.json'),
      JSON.stringify({
        hermesImported: true,
        providers: [
          {
            id: 'bridge:r',
            origin: 'custom',
            name: 'RespAPI',
            baseUrl: 'http://127.0.0.1:' + up.address().port + '/v1',
            apiMode: 'responses',
            model: 'rm',
            models: ['rm'],
            apiKey: 'SECRET-KEY',
          },
        ],
      }),
    );
    const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'mcp-server.cjs')], {
      env: {
        ...process.env,
        CODEX_HOME: codex,
        BRIDGE_HOME: bridge,
        BRIDGE_HERMES_HOME: path.join(root, 'none'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => child.kill());
    let buf = '',
      seq = 0;
    const waiting = new Map();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let n;
      while ((n = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, n));
        buf = buf.slice(n + 1);
        waiting.get(m.id)?.(m);
        waiting.delete(m.id);
      }
    });
    const rpc = (method, params) =>
      new Promise((res) => {
        const id = ++seq;
        waiting.set(id, res);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    const tool = async (name, args = {}) => {
      const m = await rpc('tools/call', { name, arguments: args });
      return { text: m.result.content[0].text, isError: !!m.result.isError };
    };
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    assert.equal(init.result.serverInfo.name, 'codex-api-switcher');
    assert.ok(init.result.capabilities.tools);
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
    const tools = (await rpc('tools/list', {})).result.tools.map((x) => x.name);
    assert.deepEqual(
      tools.sort(),
      [
        'current_api_config',
        'delete_api_config',
        'list_api_configs',
        'list_models',
        'open_api_manager',
        'switch_api_config',
        'switch_to_official',
        'test_api_config',
      ].sort(),
    );
    let r = await tool('list_api_configs');
    assert.match(r.text, /▶ Codex 官方/);
    assert.match(r.text, /RespAPI/);
    assert.equal(r.text.includes('SECRET-KEY'), false);
    r = await tool('switch_api_config', { config: 'RespAPI' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /已切换到「RespAPI」（直连/);
    const c = toml.parse(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8'));
    assert.equal(c.model_provider, 'hermes_bridge');
    assert.equal(c.model, 'rm');
    r = await tool('current_api_config');
    assert.match(r.text, /RespAPI/);
    r = await tool('delete_api_config', { config: 'RespAPI' });
    assert.equal(r.isError, true);
    assert.match(r.text, /正在被 Codex 使用/);
    r = await tool('switch_api_config', { config: '官方' });
    assert.match(r.text, /官方登录（模型 gpt-official）/);
    r = await tool('switch_api_config', { config: '不存在的' });
    assert.equal(r.isError, true);
    assert.match(r.text, /可用：官方、RespAPI/);
    r = await tool('delete_api_config', { config: 'RespAPI' });
    assert.equal(r.isError, false);
    assert.match(r.text, /已删除/);
    assert.equal((await rpc('nope/method', {})).error.code, -32601);
  },
);
