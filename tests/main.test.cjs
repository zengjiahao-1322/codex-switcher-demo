const { PROJECT_ROOT } = require('../src/paths.cjs');
// 端到端：启动真实 main.cjs（临时 Hermes/Codex/bridge/启动文件夹 + 本机模拟上游）。不触碰真实配置。
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http'),
  net = require('node:net'),
  { spawn } = require('node:child_process'),
  toml = require('smol-toml');
const freePort = () =>
  new Promise((r) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
const testHomes = [];
test.after(() => {
  for (const home of testHomes)
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
// 模拟上游：/models 列表；/responses 404（迫使转换模式）；/chat/completions 对检测返回工具调用、对普通请求返回 MOCK_REPLY。
async function mockUpstream() {
  const s = http.createServer(async (q, r) => {
    let raw = '';
    for await (const c of q) raw += c;
    r.setHeader('content-type', 'application/json');
    if (q.url.includes('/rejected/')) {
      r.writeHead(401);
      r.end('{}');
      return;
    }
    if (q.method === 'GET' && q.url.endsWith('/models')) {
      r.end(JSON.stringify({ data: [{ id: 'm' }, { id: 'm-large' }] }));
      return;
    }
    if (q.url.endsWith('/responses')) {
      r.writeHead(404);
      r.end('{}');
      return;
    }
    const b = JSON.parse(raw);
    const ping = b.tools?.some((x) => x.function?.name === 'bridge_ping');
    r.end(
      JSON.stringify(
        ping
          ? {
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: 'c',
                        type: 'function',
                        function: { name: 'bridge_ping', arguments: '{"ok":true}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }
          : {
              choices: [{ message: { content: 'MOCK_REPLY' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
      ),
    );
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + s.address().port + '/v1', close: () => s.close() };
}
async function startMain(t, dirs, port, extraEnv = {}) {
  if (require('./backend.cjs').isRust) {
    const server = require('./backend.cjs').createServer(
      { token: 'main-fixture' },
      { codexHome: dirs.codex, bridgeHome: dirs.bridge, env: extraEnv },
    );
    t.after(() => new Promise((resolve) => server.close(resolve)));
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    server.address();
    return apiFor(new URL(server.url));
  }
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'main.cjs'), '--no-open'], {
    env: {
      ...process.env,
      BRIDGE_HERMES_HOME: dirs.hermes,
      BRIDGE_CODEX_HOME: dirs.codex,
      BRIDGE_HOME: dirs.bridge,
      BRIDGE_PORT: String(port),
      BRIDGE_STARTUP_DIR: dirs.startup,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('BRIDGE_READY')) resolve();
    });
    child.on('exit', (c) => reject(Error('main exited ' + c)));
  });
  const u = new URL(
    JSON.parse(fs.readFileSync(path.join(dirs.bridge, 'running.json'), 'utf8')).url,
  );
  return apiFor(u);
}
function apiFor(u) {
  return async (route, data) => {
    const r = await fetch(u.origin + '/api/' + route, {
      method: data ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + u.hash.slice(1),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    const j = await r.json();
    if (!r.ok) throw Error(j.error);
    return j;
  };
}
function makeDirs(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  testHomes.push(root);
  const d = Object.fromEntries(
    ['hermes', 'codex', 'bridge', 'startup'].map((n) => [n, path.join(root, n)]),
  );
  Object.values(d).forEach((x) => fs.mkdirSync(x));
  return d;
}
test(
  'independent store: Hermes imported once; official entry first; adapter switch, official switch, edit/delete of imported configs',
  { timeout: 180000 },
  async (t) => {
    const up = await mockUpstream();
    t.after(up.close);
    const dirs = makeDirs('bridge-main-');
    fs.writeFileSync(
      path.join(dirs.hermes, 'config.yaml'),
      `model:\n  provider: chatonly\n  default: m\nproviders:\n  chatonly:\n    name: ChatOnly\n    base_url: ${up.url}\n    api_key: hermes-key\n    api_mode: chat_completions\n    model: m\n`,
    );
    // 官方模型缓存：Codex 要求模型目录条目字段完整，所以用本机真实缓存的条目作模板（改成测试用名称）；本机没有时退回简化条目，跳过目录断言。
    const realCache = path.join(os.homedir(), '.codex', 'models_cache.json'),
      tpl = fs.existsSync(realCache)
        ? JSON.parse(fs.readFileSync(realCache, 'utf8')).models?.find(
            (m) => m.visibility !== 'hide',
          )
        : null;
    const entry = (slug, visibility) =>
      tpl ? { ...tpl, slug, display_name: slug, visibility } : { slug, visibility };
    fs.writeFileSync(path.join(dirs.codex, 'config.toml'), 'model = "official-model"\n');
    fs.writeFileSync(
      path.join(dirs.codex, 'models_cache.json'),
      JSON.stringify({
        models: [
          entry('official-model', 'list'),
          entry('official-2', 'list'),
          entry('hidden', 'hide'),
        ],
      }),
    );
    fs.writeFileSync(
      path.join(dirs.codex, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'SECRET-TOKEN' } }),
    );
    // 旧设置直接忽略：即使保存过 ask，也不应拦住默认切换。
    fs.writeFileSync(
      path.join(dirs.bridge, 'settings.json'),
      JSON.stringify({ threadFollow: 'ask' }),
    );
    const port = await freePort();
    const api = await startMain(t, dirs, port);
    const config = () => toml.parse(fs.readFileSync(path.join(dirs.codex, 'config.toml'), 'utf8'));
    let s = await api('state');
    assert.deepEqual(
      s.providers.map((p) => p.id),
      ['official', 'chatonly'],
    );
    const off = s.providers[0];
    assert.equal(off.inUse, true);
    assert.equal(off.login, 'chatgpt');
    assert.deepEqual(off.models, ['official-model', 'official-2']);
    assert.equal(s.current.official, true);
    assert.equal(Object.hasOwn(s, 'threadFollow'), false);
    assert.deepEqual(s.usage, { mode: 'official', notice: '' });
    const json = JSON.stringify(s);
    assert.equal(json.includes('hermes-key'), false);
    assert.equal(json.includes('SECRET-TOKEN'), false);
    assert.equal(s.providers[1].source, 'hermes');
    assert.equal(s.providers[1].hasKey, true);
    assert.deepEqual((await api('models', { id: 'official' })).models, [
      'official-model',
      'official-2',
    ]);
    assert.deepEqual((await api('models', { id: 'chatonly' })).models, ['m', 'm-large']);
    // 未检测直接切换：自动检测 → 转换模式；旧对话默认全部跟随。
    const sw = await api('switch', { id: 'chatonly', model: 'm' });
    assert.equal(sw.mode, 'adapter');
    assert.match(sw.message, /配置已应用/);
    assert.equal((await api('state')).effect.status, 'restart_required');
    assert.match(sw.message, /API 模式/);
    assert.equal(config().model_providers.hermes_bridge.requires_openai_auth, false);
    assert.equal(config().model_providers.hermes_bridge.base_url, `http://127.0.0.1:${port}/v1`);
    assert.equal(fs.readdirSync(dirs.startup).length, 1);
    // Codex 模型下拉：生成的目录只含该配置的模型，当前模型排第一。
    if (tpl) {
      assert.deepEqual(
        JSON.parse(fs.readFileSync(config().model_catalog_json, 'utf8')).models.map((x) => x.slug),
        ['m', 'm-large'],
      );
      assert.match(sw.message, /2 个模型/);
    } else assert.match(sw.message, /仍显示官方列表/);
    const token = JSON.parse(fs.readFileSync(path.join(dirs.bridge, 'adapter.json'), 'utf8')).token;
    const r = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    });
    assert.equal((await r.json()).output[0].content[0].text, 'MOCK_REPLY');
    s = await api('state');
    assert.equal(s.providers[1].inUse, true);
    assert.equal(s.providers[0].inUse, false);
    assert.equal(s.usage.mode, 'custom_api');
    assert.match(s.usage.notice, /官方旧会话.*无法加载/);
    await assert.rejects(api('providerRemove', { id: 'chatonly' }), /正在被 Codex 使用/);
    await assert.rejects(api('providerRemove', { id: 'official' }), /不能删除/);
    await assert.rejects(api('providerUpdate', { id: 'official', name: 'x' }), /不能编辑/);
    // 关闭开机自启后再次切换不会擅自重新开启。
    await api('autostart', { enabled: false });
    await api('switch', { id: 'chatonly', model: 'm', threadFollow: 'off' });
    assert.equal(fs.readdirSync(dirs.startup).length, 0);
    // 配置里指定了“其他可选模型”时，Codex 下拉只显示 默认模型 + 这些；说明标明来自哪个配置。
    if (tpl) {
      await api('providerUpdate', { id: 'chatonly', models: 'picked-1, picked-2' });
      await api('switch', { id: 'chatonly', model: 'm', threadFollow: 'off' });
      const cat = JSON.parse(fs.readFileSync(config().model_catalog_json, 'utf8')).models;
      assert.deepEqual(
        cat.map((x) => x.slug),
        ['m', 'picked-1', 'picked-2'],
      );
      assert.ok(
        cat.every((x) => x.display_name === x.slug && x.description.startsWith('ChatOnly · ')),
      );
    }
    // 地址或密钥改动后必须重新检测；不能沿用正在使用时的旧接入方式。
    const beforeRejected = fs.readFileSync(path.join(dirs.codex, 'config.toml'), 'utf8');
    await api('providerUpdate', {
      id: 'chatonly',
      baseUrl: up.url + '/rejected',
      apiKey: 'changed-key',
    });
    await assert.rejects(
      api('switch', { id: 'chatonly', model: 'm', threadFollow: 'off' }),
      /检测未通过/,
    );
    assert.equal(fs.readFileSync(path.join(dirs.codex, 'config.toml'), 'utf8'), beforeRejected);
    await api('providerUpdate', { id: 'chatonly', baseUrl: up.url, apiKey: 'hermes-key' });
    // 切到官方（指定官方模型），保留 hermes_bridge 定义，凭据文件不变。
    const authBefore = fs.readFileSync(path.join(dirs.codex, 'auth.json'), 'utf8');
    const o = await api('switch', { id: 'official', model: 'official-2', threadFollow: 'off' });
    assert.equal(o.mode, 'official');
    assert.match(o.message, /完整退出/);
    assert.equal(config().model, 'official-2');
    assert.equal(config().model_provider, undefined);
    assert.ok(config().model_providers.hermes_bridge);
    assert.equal(
      config().model_catalog_json,
      undefined,
      'official switch removes the generated catalog',
    );
    assert.equal(fs.readFileSync(path.join(dirs.codex, 'auth.json'), 'utf8'), authBefore);
    assert.deepEqual((await api('state')).usage, { mode: 'official', notice: '' });
    // 导入的配置可编辑（密钥留空保留）与删除；删除后自动导入不会复活，手动导入可找回。
    await api('providerUpdate', { id: 'chatonly', name: 'ChatOnly 改名', apiKey: '' });
    s = await api('state');
    assert.equal(s.providers[1].name, 'ChatOnly 改名');
    assert.equal(s.providers[1].hasKey, true);
    assert.match((await api('providerRemove', { id: 'chatonly' })).message, /已删除/);
    s = await api('state');
    assert.equal(s.providers.length, 1);
    assert.match((await api('importHermes', {})).message, /已导入 1 个/);
    s = await api('state');
    assert.equal(s.providers.length, 2);
    assert.match((await api('restore', { threadFollow: 'off' })).message, /已是官方/);
  },
);
test(
  'main service works without Hermes and without Codex config',
  { timeout: 60000 },
  async (t) => {
    const dirs = makeDirs('bridge-main-missing-');
    fs.rmSync(dirs.hermes, { recursive: true });
    fs.rmSync(dirs.codex, { recursive: true });
    const api = await startMain(t, dirs, await freePort());
    const s = await api('state');
    assert.deepEqual(
      s.providers.map((p) => p.id),
      ['official'],
    );
    assert.equal(s.hermesAvailable, false);
    await assert.rejects(api('importHermes', {}), /未找到 Hermes/);
  },
);

test('changing the managed home immediately reads the selected config and preserves both files', async (t) => {
  const dirs = makeDirs('switcher-home-selection-'),
    api = await startMain(t, dirs, await freePort()),
    other = path.join(dirs.bridge, 'other-home');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(dirs.codex, 'config.toml'), 'model="first-model"\n');
  fs.writeFileSync(path.join(other, 'config.toml'), 'model="second-model"\n');
  assert.equal((await api('state')).current.model, 'first-model');
  await api('setEnvironment', { home: other });
  assert.equal((await api('state')).current.model, 'second-model');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dirs.bridge, 'settings.json'), 'utf8')).codexHome,
    other,
  );
  assert.equal(
    fs.readFileSync(path.join(dirs.codex, 'config.toml'), 'utf8'),
    'model="first-model"\n',
  );
  assert.equal(fs.readFileSync(path.join(other, 'config.toml'), 'utf8'), 'model="second-model"\n');
});

test(
  '固定端口只接管同安装目录旧服务，保留其他目录的同名入口',
  { timeout: 60000, skip: !['win32', 'darwin'].includes(process.platform) },
  async (t) => {
    const oldDirs = makeDirs('switcher-port-old-'),
      newDirs = makeDirs('switcher-port-new-'),
      port = await freePort();
    const launch = (dirs, entry = path.join(PROJECT_ROOT, 'main.cjs'), selectedPort = port) => {
      const rust = require('./backend.cjs').isRust && entry === path.join(PROJECT_ROOT, 'main.cjs');
      const child = spawn(
        rust ? require('./backend.cjs').rustBinary() : process.execPath,
        rust ? ['--no-open'] : [entry, '--no-open'],
        {
          env: {
            ...process.env,
            BRIDGE_HERMES_HOME: dirs.hermes,
            BRIDGE_CODEX_HOME: dirs.codex,
            BRIDGE_HOME: dirs.bridge,
            BRIDGE_PORT: String(selectedPort),
            ...(rust
              ? { CODEX_HOME: dirs.codex, SWITCHER_WEB_ROOT: path.join(PROJECT_ROOT, 'web') }
              : {}),
          },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const output = [];
      child.stdout.on('data', (chunk) => output.push(String(chunk)));
      child.stderr.on('data', (chunk) => output.push(String(chunk)));
      const closed = new Promise((resolve) => child.once('close', resolve));
      t.after(async () => {
        child.kill();
        await closed;
      });
      return { child, output, closed };
    };
    const old = launch(oldDirs);
    const waitReady = (item) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error('固定端口测试启动超时：' + item.output.join(''))),
          15000,
        );
        const check = () => {
          if (
            item.output.join('').includes('BRIDGE_READY') ||
            (require('./backend.cjs').isRust && item.output.join('').includes('"event":"ready"'))
          ) {
            clearTimeout(timer);
            resolve();
          }
        };
        item.output.push = (
          (push) =>
          (...values) => {
            const result = push(...values);
            check();
            return result;
          }
        )(item.output.push.bind(item.output));
        item.child.once('exit', (code) => {
          clearTimeout(timer);
          reject(Error('固定端口测试进程退出：' + code + '\n' + item.output.join('')));
        });
        check();
      });
    await waitReady(old);
    const oldRecord = JSON.parse(fs.readFileSync(path.join(oldDirs.bridge, 'running.json')));
    fs.writeFileSync(
      path.join(newDirs.bridge, 'running.json'),
      JSON.stringify({ pid: oldRecord.pid, url: 'http://127.0.0.1:9/#stale' }),
    );
    const next = launch(newDirs);
    await waitReady(next);
    const nextRecord = JSON.parse(fs.readFileSync(path.join(newDirs.bridge, 'running.json')));
    assert.equal(new URL(nextRecord.url).port, String(port));
    const { readRecent } = require('../src/diagnostics/event-log.cjs');
    assert.deepEqual(readRecent(newDirs.bridge, 10).find((e) => e.event === 'startup').reclaimed, {
      pid: old.child.pid,
    });
    await old.closed;

    // 另一个目录也叫 main.cjs；路径带空格覆盖 macOS ps 的无引号输出。
    const foreignDirs = makeDirs('switcher-other install-'),
      fallbackDirs = makeDirs('switcher-fallback-'),
      foreignPort = await freePort(),
      foreignEntry = path.join(path.dirname(foreignDirs.bridge), 'main.cjs');
    fs.writeFileSync(
      foreignEntry,
      "require('node:http').createServer((q,r)=>r.end('fixture')).listen(Number(process.env.BRIDGE_PORT),'127.0.0.1',()=>console.log('BRIDGE_READY'));",
    );
    const foreign = launch(foreignDirs, foreignEntry, foreignPort);
    await waitReady(foreign);
    const fallback = launch(fallbackDirs, path.join(PROJECT_ROOT, 'main.cjs'), foreignPort);
    await waitReady(fallback);
    const fallbackRecord = JSON.parse(
      fs.readFileSync(path.join(fallbackDirs.bridge, 'running.json')),
    );
    assert.notEqual(new URL(fallbackRecord.url).port, String(foreignPort));
    assert.equal(process.kill(foreign.child.pid, 0), true);
    assert.deepEqual(
      readRecent(fallbackDirs.bridge, 10).find((e) => e.event === 'startup').portFallback,
      { port: foreignPort, ownerPid: foreign.child.pid, reason: 'different_process' },
    );
  },
);

test('再次启动已运行实例时修复发现文件且保留原实例pid/url/build', async (t) => {
  const dirs = makeDirs('switcher-discovery-repair-'),
    discovery = path.join(dirs.bridge, 'discovery'),
    port = await freePort();
  await startMain(t, dirs, port, { BRIDGE_DISCOVERY_DIR: discovery });
  const prior = JSON.parse(fs.readFileSync(path.join(dirs.bridge, 'running.json')));
  fs.writeFileSync(
    path.join(discovery, 'connection.json'),
    JSON.stringify({ url: 'http://127.0.0.1:9/#stale', pid: 1 }),
  );
  const rust = require('./backend.cjs').isRust;
  const child = spawn(
    rust ? require('./backend.cjs').rustBinary() : process.execPath,
    rust ? ['--no-open'] : [path.join(PROJECT_ROOT, 'main.cjs'), '--no-open'],
    {
      env: {
        ...process.env,
        BRIDGE_HOME: dirs.bridge,
        BRIDGE_CODEX_HOME: dirs.codex,
        BRIDGE_HERMES_HOME: dirs.hermes,
        BRIDGE_DISCOVERY_DIR: discovery,
        SWITCHER_WEB_ROOT: path.join(PROJECT_ROOT, 'web'),
      },
      windowsHide: true,
      stdio: 'ignore',
    },
  );
  const code = await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(discovery, 'connection.json'))), prior);
});
