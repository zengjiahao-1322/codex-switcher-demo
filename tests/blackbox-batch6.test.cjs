'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http'),
  crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { isRust, rustBinary } = require('./backend.cjs');
const { startBackend, launchBackend } = require('./backend-process.cjs');
const { api, serve, responseTool } = require('./config-blackbox-helpers.cjs');
const { packageFixture, snapshot, until, write } = require('./fixtures/batch6-package.cjs');
const project = path.resolve(__dirname, '..');
async function occupyRuntime(f) {
  if (process.platform !== 'win32' || (!isRust && !fs.existsSync(rustBinary()))) return null;
  const node = path.join(f.target, 'runtime/node.exe');
  if (!fs.existsSync(node)) fs.copyFileSync(process.execPath, node);
  const child = spawn(node, [path.join(f.target, 'mcp-server.cjs')], {
    cwd: f.root,
    env: f.environment,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  f.track(child);
  const closed = require('node:events').once(child, 'close');
  let error = '';
  child.stderr.on('data', (chunk) => (error += chunk));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('TEMP MCP did not initialize: ' + error)), 10000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('"serverInfo"')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  child.stdin.write(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}}\n',
  );
  await ready;
  assert.throws(() => fs.unlinkSync(node), { code: 'EPERM' });
  return { child, closed };
}
async function verifyOldCleanup(f, record, occupant) {
  if (!occupant) return record;
  assert.equal(occupant.child.exitCode, null, 'the MCP must survive replacement');
  assert.equal(occupant.child.signalCode, null);
  const parked = fs
    .readdirSync(path.join(f.target, 'runtime'))
    .filter((name) => name.startsWith('node.exe.old-'));
  assert.ok(parked.length > 0, 'the loaded image is parked beside node.exe');
  occupant.child.kill();
  await occupant.closed;
  const url = new URL(record.url);
  const stopped = await fetch(url.origin + '/api/quit', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + url.hash.slice(1), 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(stopped.status, 200);
  await until(() => !fs.existsSync(path.join(f.bridge, 'running.json')), 5000);
  const restarted = launchBackend(f.environment);
  f.track(restarted);
  const next = await until(() => {
    const file = path.join(f.bridge, 'running.json');
    if (!fs.existsSync(file)) return false;
    const current = JSON.parse(fs.readFileSync(file));
    return current.pid !== record.pid && current.build.id === record.build.id && current;
  }, 12000);
  assert.equal(
    fs.readdirSync(path.join(f.target, 'runtime')).some((name) => name.startsWith('node.exe.old-')),
    false,
  );
  console.log(
    JSON.stringify({
      event: 'occupied-runtime-preserved-and-cleaned',
      backend: isRust ? 'rust' : 'node',
      occupantPid: occupant.child.pid,
      oldFiles: parked.length,
      restartedPid: next.pid,
    }),
  );
  return next;
}
const privateSentinel = (f) =>
  path.join(process.platform === 'win32' ? f.target : f.bridge, 'private/sentinel');
function metadata(f, extra = {}) {
  return {
    version: '0.1.6',
    build: 'b'.repeat(12),
    sequence: 101,
    commit: 'c'.repeat(40),
    publishedAt: '2026-10-28T00:00:00Z',
    notes: 'isolated release',
    assets: { [f.asset]: 'd'.repeat(64) },
    ...extra,
  };
}
async function updateState(f) {
  return (await api(f, 'state')).update;
}
async function failed(f, pattern) {
  const state = await until(async () => {
    const s = await updateState(f);
    return s.status === 'error' && s;
  }, 20000);
  assert.match(state.error, pattern);
  return state;
}
async function packageArchive(f, modify = () => {}) {
  const source = f.source();
  const build = f.makePackage(source, 101);
  await modify(source, build);
  const actual = f.build(source),
    archive = path.join(f.root, f.asset);
  f.archive(source, archive);
  f.response.archive = archive;
  f.response.metadata = metadata(f, {
    build: actual.id,
    assets: {
      [f.asset]: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
    },
  });
  return { source, build: actual, archive };
}

test('更新黑盒：发行元数据校验、六小时合并与同版仅较大发行序号可升级', async (t) => {
  const f = await packageFixture(t);
  f.response.metadata = metadata(f);
  for (const sequence of [undefined, null, '101', 0, -1, 1.5]) {
    f.response.metadata.sequence = sequence;
    assert.equal((await api(f, 'checkUpdate', {})).status, 'error');
  }
  f.response.metadata.sequence = 101;
  const results = await Promise.all([api(f, 'checkUpdate', {}), api(f, 'checkUpdate', {})]);
  for (const result of results) {
    assert.equal(result.status, 'available');
    assert.equal(result.latest.sequence, 101);
    assert.equal(result.latest.build, 'b'.repeat(12));
    assert.equal(result.current.sequence, 100);
  }
  await api(f, 'checkUpdate', {});
  assert.equal(f.requests.filter((x) => x === '/release.json').length, 7);
  assert.equal((await updateState(f)).status, 'available');
});
test('更新黑盒：相同或更低序号不下载、不改程序全文', async (t) => {
  for (const sequence of [100, 99]) {
    const f = await packageFixture(t);
    f.response.metadata = metadata(f, { sequence, build: 'f'.repeat(12) });
    const before = snapshot(f.target);
    assert.equal((await api(f, 'checkUpdate', {})).status, 'idle');
    assert.match((await api(f, 'installUpdate', {}, 400)).error, /不会安装相同或更旧/);
    assert.deepEqual(snapshot(f.target), before);
    assert.deepEqual(f.requests, ['/release.json']);
  }
});
test('更新黑盒：开发目录仍可检查，拒绝安装和外部参数', async (t) => {
  const f = await packageFixture(t, { dev: true });
  f.response.metadata = metadata(f);
  const state = await api(f, 'checkUpdate', {});
  assert.equal(state.dev, true);
  assert.equal(state.current.sequence, null);
  assert.equal(state.status, 'idle');
  assert.match(
    (await api(f, 'installUpdate', { url: 'http://127.0.0.1/anything' }, 400)).error,
    /不接受地址/,
  );
  assert.match((await api(f, 'installUpdate', {}, 400)).error, /开发目录/);
});
test('更新黑盒：下载中断和SHA不符保留完整安装与私有数据', async (t) => {
  const f = await packageFixture(t);
  f.response.metadata = metadata(f);
  f.response.cut = true;
  const before = snapshot(f.target);
  await api(f, 'checkUpdate', {});
  await api(f, 'installUpdate', {});
  await failed(f, /连接 GitHub/);
  assert.deepEqual(snapshot(f.target), before);
  f.response.cut = false;
  const bad = path.join(f.root, 'bad.zip');
  write(bad, 'wrong bytes');
  f.response.archive = bad;
  await api(f, 'installUpdate', {});
  await failed(f, /校验和不匹配/);
  assert.deepEqual(snapshot(f.target), before);
  assert.equal(fs.readFileSync(privateSentinel(f), 'utf8'), 'preserve private');
  assert.equal(
    fs.readFileSync(path.join(f.bridge, 'accounts/keep.txt'), 'utf8'),
    'preserve credentials',
  );
});
for (const field of ['build', 'sequence'])
  test('更新黑盒：包内' + field + '不符拒绝安装且文件全文不变', { timeout: 90000 }, async (t) => {
    const f = await packageFixture(t);
    await packageArchive(f);
    f.response.metadata[field] = field === 'build' ? 'a'.repeat(12) : 102;
    const before = snapshot(f.target);
    await api(f, 'checkUpdate', {});
    await api(f, 'installUpdate', {});
    await failed(f, field === 'build' ? /构建号/ : /发行序号/);
    assert.deepEqual(snapshot(f.target), before);
    assert.equal(fs.existsSync(path.join(f.bridge, 'updates/previous')), false);
  });
test('更新黑盒：真实下载校验换包换进程，健康检查和发现目录交接', { timeout: 90000 }, async (t) => {
  const f = await packageFixture(t);
  const occupant = await occupyRuntime(f);
  const incoming = await packageArchive(f, async (source) => {
    if (!occupant || isRust) return;
    const native = path.join(source, 'codex-switcher.exe');
    fs.copyFileSync(rustBinary(), native);
    fs.copyFileSync(
      path.join(path.dirname(rustBinary()), 'upgrade-bridge.exe'),
      path.join(source, 'runtime/node.exe'),
    );
    const build = JSON.parse(
      execFileSync(native, ['--build-info'], {
        env: { ...process.env, SWITCHER_WEB_ROOT: path.join(source, 'web') },
        encoding: 'utf8',
        windowsHide: true,
      }),
    );
    write(
      path.join(source, 'src/platform/build-info.cjs'),
      'exports.buildInfo=()=>(' + JSON.stringify(build) + ');\n',
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'release-files.json')));
    manifest.push('codex-switcher.exe');
    write(path.join(source, 'release-files.json'), JSON.stringify(manifest));
  });
  write(path.join(f.target, 'obsolete.txt'), 'old entry');
  const oldFiles = JSON.parse(fs.readFileSync(path.join(f.target, 'release-files.json')));
  oldFiles.push('obsolete.txt');
  write(path.join(f.target, 'release-files.json'), JSON.stringify(oldFiles));
  const privateFile = privateSentinel(f),
    mode = fs.statSync(privateFile).mode & 0o777;
  const acl =
    process.platform === 'win32'
      ? execFileSync('icacls.exe', [path.join(f.bridge, 'accounts/keep.txt')], { encoding: 'utf8' })
      : null;
  await api(f, 'checkUpdate', {});
  await api(f, 'installUpdate', {});
  console.log(JSON.stringify({ event: 'update-staged', root: f.root, build: incoming.build }));
  const record = await until(() => {
    const resultFile = path.join(f.bridge, 'updates/result.json');
    if (fs.existsSync(resultFile)) {
      const result = JSON.parse(fs.readFileSync(resultFile));
      if (result.error) throw Error(result.error);
    }
    const file = path.join(f.bridge, 'running.json');
    if (!fs.existsSync(file)) return false;
    const r = JSON.parse(fs.readFileSync(file));
    return r.build.id === incoming.build.id && r;
  }, 45000).catch((error) => {
    const log = path.join(f.bridge, 'logs/switcher.log');
    throw Error(
      error.message + '\n' + (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : 'no log'),
    );
  });
  await until(() => {
    const file = path.join(f.bridge, 'logs/switcher.log');
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('"status":"done"');
  }, 10000);
  const url = new URL(record.url);
  const response = await fetch(url.origin + '/api/runtime', {
    headers: { Authorization: 'Bearer ' + url.hash.slice(1) },
  });
  assert.equal((await response.json()).id, incoming.build.id);
  assert.notEqual(record.pid, f.child.pid);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.root, 'discovery/connection.json'))),
    record,
  );
  assert.equal(record.build.sequence, 101);
  assert.equal(fs.existsSync(path.join(f.target, 'obsolete.txt')), false);
  assert.equal(fs.readFileSync(privateFile, 'utf8'), 'preserve private');
  assert.equal(fs.statSync(privateFile).mode & 0o777, mode);
  assert.equal(
    fs.readFileSync(path.join(f.bridge, 'accounts/keep.txt'), 'utf8'),
    'preserve credentials',
  );
  if (acl)
    assert.equal(
      execFileSync('icacls.exe', [path.join(f.bridge, 'accounts/keep.txt')], { encoding: 'utf8' }),
      acl,
    );
  const old = path.join(
    f.bridge,
    'updates/previous',
    process.platform === 'win32'
      ? 'obsolete.txt'
      : 'Codex Switcher.app/Contents/Resources/obsolete.txt',
  );
  assert.equal(fs.readFileSync(old, 'utf8'), 'old entry');
  assert.deepEqual(f.requests, ['/release.json', '/' + f.asset]);
  await verifyOldCleanup(f, record, occupant);
  console.log(
    JSON.stringify({
      event: 'update-replaced',
      backend: isRust ? 'rust' : 'node',
      oldPid: f.child.pid,
      newPid: record.pid,
      build: record.build,
      requests: f.requests,
    }),
  );
});

test('生命周期黑盒：活动任务拒绝退出，退出只清本进程运行与发现记录', async (t) => {
  const f = await startBackend(t, {
    setup({ root, environment }) {
      environment.BRIDGE_DISCOVERY_DIR = path.join(root, 'discovery');
    },
  });
  write(
    path.join(f.bridge, 'account-switch.json'),
    JSON.stringify({ status: 'preparing', pid: f.child.pid }),
  );
  assert.match((await api(f, 'quit', {}, 400)).error, /切换任务正在进行/);
  assert.match((await api(f, 'uninstall', {}, 400)).error, /切换任务正在进行/);
  write(
    path.join(f.bridge, 'account-switch.json'),
    JSON.stringify({ status: 'done', pid: f.child.pid }),
  );
  assert.equal((await api(f, 'quit', {})).message, '切换器已退出');
  await f.closed;
  assert.equal(fs.existsSync(path.join(f.bridge, 'running.json')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'discovery/connection.json')), false);
});

test('CLI黑盒：status、restore、cleanup全文和退出码，保留原配置与关闭TEMP自启', async (t) => {
  const f = await startBackend(t);
  await api(f, 'quit', {});
  await f.closed;
  const file = path.join(f.home, 'config.toml'),
    original = 'model = "official"\n# user setting\n[mcp_servers.keep]\ncommand = "keep"\n';
  write(file, original);
  write(path.join(f.bridge, 'original-config.toml'), original);
  const run = (action) => {
    const child = require('node:child_process').spawnSync(
      isRust ? rustBinary() : process.execPath,
      isRust ? ['--cli', action] : [path.join(project, 'scripts/cli.cjs'), action],
      { env: f.environment, windowsHide: true, encoding: 'utf8', timeout: 15000 },
    );
    return { stdout: child.stdout.trim(), stderr: child.stderr.trim(), code: child.status };
  };
  assert.equal(run('status').stdout, 'OFFICIAL');
  assert.equal(run('restore').stdout, 'Codex already uses its official login.');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  write(
    file,
    'model = "custom"\nmodel_provider = "hermes_bridge"\n# user setting\n[mcp_servers.keep]\ncommand = "keep"\n[model_providers.hermes_bridge]\nname = "fixture"\nbase_url = "http://127.0.0.1:1/v1"\n',
  );
  assert.equal(run('status').stdout, 'BRIDGED');
  assert.equal(run('cleanup').code, 1);
  assert.equal(run('restore').stdout, 'Restored Codex official login (model official).');
  const kept =
    'model = "official"\n# user setting\n[mcp_servers.keep]\ncommand = "keep"\n[model_providers.hermes_bridge]\nname = "fixture"\nbase_url = "http://127.0.0.1:1/v1"\n';
  assert.equal(fs.readFileSync(file, 'utf8'), kept);
  const link = path.join(
    f.environment.BRIDGE_STARTUP_DIR,
    process.platform === 'win32'
      ? 'Codex API Switcher Service.lnk'
      : 'com.codex-switcher.demo.plist',
  );
  write(link, 'isolated startup');
  assert.equal(
    run('cleanup').stdout,
    'Removed the switcher provider definition from Codex config.',
  );
  assert.equal(fs.existsSync(link), false);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(run('cleanup').stdout, 'Codex config had nothing to clean.');
  assert.equal(run('bogus').code, 2);
});

function mcpClient(t, f) {
  const child = spawn(
    isRust ? rustBinary() : process.execPath,
    isRust ? ['--mcp'] : [path.join(project, 'mcp-server.cjs')],
    { cwd: f.root, env: f.environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  f.track(child);
  let buf = '',
    seq = 0,
    stderr = '';
  const pending = new Map(),
    raw = [];
  child.stderr.on('data', (data) => (stderr += data));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    buf += data;
    let n;
    while ((n = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, n);
      buf = buf.slice(n + 1);
      raw.push(line + '\n');
      const value = JSON.parse(line);
      pending.get(value.id)?.resolve({ value, raw: line + '\n' });
      pending.delete(value.id);
    }
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq,
        timer = setTimeout(() => reject(Error('MCP timeout ' + method + ' ' + stderr)), 15000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return { rpc, raw, child };
}

test(
  'MCP黑盒：原握手、工具清单和七种工具调用逐字节对照Node，磁盘全文与密钥隔离',
  { timeout: 90000 },
  async (t) => {
    const up = await serve(t, (request, res) =>
      res.end(JSON.stringify(request.method === 'GET' ? { data: [{ id: 'rm' }] } : responseTool)),
    );
    const f = await startBackend(t, {
      startupTimeout: 30000,
      setup({ home, bridge }) {
        write(path.join(home, 'config.toml'), 'model = "gpt-official"\n');
        write(
          path.join(home, 'models_cache.json'),
          JSON.stringify({ models: [{ slug: 'gpt-official', visibility: 'list' }] }),
        );
        write(
          path.join(bridge, 'providers.json'),
          JSON.stringify({
            hermesImported: true,
            providers: [
              {
                id: 'bridge:r',
                origin: 'custom',
                name: 'RespAPI',
                baseUrl: up.url + '/v1',
                apiMode: 'responses',
                model: 'rm',
                models: ['rm'],
                apiKey: 'SECRET-KEY',
              },
            ],
          }),
        );
        // Keep the MCP server's reachability probe on this fixture, never port47831.
        write(
          path.join(bridge, 'adapter.json'),
          JSON.stringify({
            port: Number(new URL(up.url).port),
            token: 'fixture-adapter-token',
            target: null,
          }),
        );
      },
    });
    await api(f, 'quit', {});
    await f.closed;
    // The reachability probe and supplier requests all stay on this TEMP HTTP fixture.
    const client = mcpClient(t, f),
      results = [];
    const record = async (method, params) => {
      const result = await client.rpc(method, params);
      results.push(result.raw);
      return result.value;
    };
    const tool = (name, args = {}) => record('tools/call', { name, arguments: args });
    await record('initialize', { protocolVersion: '2025-06-18' });
    await record('ping');
    await record('tools/list');
    let value = await tool('list_api_configs');
    assert.equal(JSON.stringify(value).includes('SECRET-KEY'), false);
    await tool('current_api_config');
    await tool('list_models', { config: 'RespAPI' });
    await tool('test_api_config', { config: 'RespAPI' });
    value = await tool('switch_api_config', { config: 'RespAPI', threadFollow: 'off' });
    assert.equal(value.result.isError, undefined, JSON.stringify(value));
    const switched = fs.readFileSync(path.join(f.home, 'config.toml'), 'utf8');
    assert.match(switched, /model_provider = "hermes_bridge"/);
    assert.match(switched, /model = "rm"/);
    await tool('current_api_config');
    await tool('delete_api_config', { config: 'RespAPI' });
    await tool('switch_api_config', { config: '官方', threadFollow: 'off' });
    await tool('switch_to_official', { threadFollow: 'off' });
    await tool('switch_api_config', { config: '不存在的' });
    await tool('delete_api_config', { config: 'RespAPI' });
    await record('nope/method');
    await tool('missing_tool');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(f.bridge, 'providers.json'))).providers,
      [],
    );
    const golden = path.join(__dirname, 'fixtures/mcp-wire.json');
    if (process.env.SWITCHER_RECORD_MCP === '1' && !isRust)
      write(golden, JSON.stringify(results, null, 2) + '\n');
    assert.deepEqual(
      results,
      JSON.parse(fs.readFileSync(golden, 'utf8')),
      'MCP protocol line bytes must equal frozen Node baseline',
    );
  },
);

test(
  '更新黑盒：新进程健康检查失败后恢复旧包、重启旧后台且私有权限不变',
  { timeout: 90000 },
  async (t) => {
    const f = await packageFixture(t);
    const incoming = await packageArchive(f, async (source) => {
      if (!isRust) {
        write(path.join(source, 'main.cjs'), 'throw Error("isolated new backend failure");\n');
        return;
      }
      const exe = path.join(source, path.basename(rustBinary()));
      if (process.platform === 'win32') {
        const code =
          'using System; public static class FailedPackage {public static void Main(string[] args){if(Array.IndexOf(args,"--build-info")>=0){Console.WriteLine("{\\\"version\\\":\\\"0.1.5\\\",\\\"id\\\":\\\"bbbbbbbbbbbb\\\",\\\"sequence\\\":101}");return;}Environment.Exit(1);}}';
        const cs = path.join(f.root, 'failed-package.cs');
        write(cs, code);
        execFileSync(
          path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
          ['/nologo', '/target:exe', '/out:' + exe, cs],
          { windowsHide: true },
        );
      } else {
        const c = path.join(f.root, 'failed-package.c');
        write(
          c,
          '#include <stdio.h>\n#include <string.h>\nint main(int argc,char**argv){if(argc>1&&!strcmp(argv[1],"--build-info")){puts("{\\\"version\\\":\\\"0.1.5\\\",\\\"id\\\":\\\"bbbbbbbbbbbb\\\",\\\"sequence\\\":101}");return 0;}return 1;}',
        );
        execFileSync('clang', [c, '-o', exe]);
      }
    });
    const before = snapshot(f.target),
      privateFile = privateSentinel(f),
      mode = fs.statSync(privateFile).mode & 0o777;
    await api(f, 'checkUpdate', {});
    await api(f, 'installUpdate', {});
    const resultFile = path.join(f.bridge, 'updates/result.json');
    await until(
      () => fs.existsSync(resultFile) && JSON.parse(fs.readFileSync(resultFile)).error,
      55000,
    );
    const record = await until(() => {
      const file = path.join(f.bridge, 'running.json');
      if (!fs.existsSync(file)) return false;
      const r = JSON.parse(fs.readFileSync(file));
      return r.pid !== f.child.pid && r.build.id === f.current.id && r;
    }, 12000);
    await until(() => {
      const file = path.join(f.bridge, 'logs/switcher.log');
      return fs.readFileSync(file, 'utf8').includes('"event":"update.rollback"');
    });
    assert.deepEqual(snapshot(f.target), before);
    assert.notEqual(record.build.id, incoming.build.id);
    assert.match(JSON.parse(fs.readFileSync(resultFile)).error, /已恢复上一版/);
    assert.equal(fs.readFileSync(privateFile, 'utf8'), 'preserve private');
    assert.equal(fs.statSync(privateFile).mode & 0o777, mode);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(f.root, 'discovery/connection.json'))),
      record,
    );
    console.log(
      JSON.stringify({
        event: 'update-rolled-back',
        backend: isRust ? 'rust' : 'node',
        newBuild: incoming.build.id,
        restarted: record.build,
        result: JSON.parse(fs.readFileSync(resultFile)),
      }),
    );
  },
);

for (const { keep, manual, stale } of [
  { keep: true },
  { keep: false },
  ...(process.platform === 'win32'
    ? [
        { keep: true, manual: true },
        { keep: true, manual: true, stale: true },
      ]
    : []),
])
  test(
    `卸载黑盒：KeepData保留私有文件，只有本机转换配置恢复官方，系统清理限TEMP（${manual ? '手动' : 'HTTP'}，KeepData=${keep}${stale ? '，旧PID指向无关进程' : ''}）`,
    { timeout: 45000 },
    async (t) => {
      let shellRoot, original, configBefore;
      const f = await packageFixture(t, {
        setup({ root, home, bridge, environment }, target) {
          original = 'model = "official"\n# preserve user\n';
          write(path.join(bridge, 'original-config.toml'), original);
          const port = Number(environment.BRIDGE_PORT);
          configBefore =
            'model = "custom"\nmodel_provider = "hermes_bridge"\n# preserve user\n[model_providers.hermes_bridge]\nname = "fixture"\nbase_url = "' +
            (keep ? 'http://127.0.0.1:' + port + '/v1' : 'http://127.0.0.1:2/v1') +
            '"\n';
          write(path.join(home, 'config.toml'), configBefore);
          write(
            path.join(bridge, 'adapter.json'),
            JSON.stringify({ port, token: 'fixture-adapter' }),
          );
          shellRoot = path.join(root, 'shell');
          environment.SWITCHER_TEST_SHELL_ROOT = shellRoot;
          for (const name of ['Desktop', 'Programs', 'Startup'])
            fs.mkdirSync(path.join(shellRoot, name), { recursive: true });
          for (const name of ['Desktop', 'Programs'])
            write(path.join(shellRoot, name, 'Codex API Switcher.lnk'), 'fixture shortcut');
          write(path.join(shellRoot, 'registration.json'), 'fixture registration');
          if (process.platform === 'win32') {
            const file = path.join(target, 'platform/windows/uninstall.ps1');
            let script = fs.readFileSync(file, 'utf8');
            for (const name of ['Desktop', 'Programs', 'Startup'])
              script = script.replaceAll(
                "[Environment]::GetFolderPath('" + name + "')",
                "(Join-Path $env:SWITCHER_TEST_SHELL_ROOT '" + name + "')",
              );
            script = script.replace(
              "$ErrorActionPreference = 'Stop'",
              "$ErrorActionPreference = 'Stop'\ntrap { $_ | Out-String | Set-Content -LiteralPath (Join-Path $env:BRIDGE_HOME 'uninstall-error.txt'); exit 1 }",
            );
            write(file, script);
            // Keep the production RemoveRegistration code; only point the registry
            // provider path at a TEMP filesystem tree, never the user's real HKCU.
            const integration = path.join(target, 'platform/windows/desktop-integration.ps1');
            write(
              integration,
              fs
                .readFileSync(integration, 'utf8')
                .replace(
                  "$registry = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CodexSwitcher'",
                  "$registry = Join-Path $env:SWITCHER_TEST_SHELL_ROOT 'registration.json'",
                ),
            );
          } else {
            const file = path.join(target, 'platform/macos/uninstall-mac.sh');
            let script = fs.readFileSync(file, 'utf8');
            script = script.replace(
              '"$HOME/Library/LaunchAgents/com.codex-switcher.demo.plist"',
              '"$SWITCHER_TEST_SHELL_ROOT/Startup/com.codex-switcher.demo.plist"',
            );
            script = script.replace(
              'expected="$HOME/Library/Application Support/CodexApiSwitcher"',
              'expected="' + bridge + '"',
            );
            write(file, script, 0o755);
          }
        },
      });
      let unrelated;
      if (manual) {
        const running = JSON.parse(fs.readFileSync(path.join(f.bridge, 'running.json')));
        if (stale) {
          await api(f, 'quit', {});
          await f.closed;
          unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
            cwd: f.root,
            windowsHide: true,
            stdio: 'ignore',
          });
          f.track(unrelated);
          running.pid = unrelated.pid;
        }
        write(path.join(f.target, 'private/running.json'), JSON.stringify(running));
        const result = require('node:child_process').spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            path.join(f.target, 'uninstall.ps1'),
            '-KeepData',
          ],
          {
            env: { ...f.environment, BRIDGE_UNINSTALL_PID: '', BRIDGE_UNINSTALL_READY: '' },
            cwd: f.root,
            windowsHide: true,
            encoding: 'utf8',
            timeout: 15000,
          },
        );
        assert.equal(result.status, 0, result.stdout + ' ' + result.stderr + ' ' + result.error);
      } else await api(f, 'uninstall', { keepData: keep });
      try {
        await until(() => f.child.exitCode !== null || f.child.signalCode !== null, 15000);
      } catch (error) {
        const log = path.join(f.bridge, 'logs/switcher.log');
        throw Error(
          error.message +
            ': ' +
            (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : 'no backend log'),
        );
      }
      await f.closed;
      if (keep)
        try {
          await until(() => !fs.existsSync(path.join(f.target, 'main.cjs')), 15000);
        } catch (e) {
          throw Error(
            e.message +
              ' ' +
              [
                'uninstall-out.log',
                'uninstall-err.log',
                'uninstall-error.txt',
                'uninstall-trace.txt',
              ]
                .map(
                  (n) =>
                    n +
                    ':' +
                    (fs.existsSync(path.join(f.bridge, n))
                      ? fs.readFileSync(path.join(f.bridge, n), 'utf8')
                      : 'missing'),
                )
                .join(' '),
          );
        }
      else await until(() => !fs.existsSync(f.target) && !fs.existsSync(f.bridge), 15000);
      if (process.platform === 'win32') assert.equal(fs.existsSync(privateSentinel(f)), keep);
      assert.equal(fs.existsSync(path.join(f.bridge, 'accounts/keep.txt')), keep);
      const config = fs.readFileSync(path.join(f.home, 'config.toml'), 'utf8');
      if (keep) {
        assert.equal(
          config,
          manual
            ? original
            : configBefore
                .replace('model = "custom"', 'model = "official"')
                .replace('model_provider = "hermes_bridge"\n', ''),
        );
      } else assert.equal(config, configBefore);
      if (process.platform === 'win32')
        for (const item of [
          'Desktop/Codex API Switcher.lnk',
          'Programs/Codex API Switcher.lnk',
          'registration.json',
        ])
          assert.equal(fs.existsSync(path.join(shellRoot, item)), false);
      if (stale) {
        assert.equal(unrelated.exitCode, null);
        assert.equal(unrelated.signalCode, null);
        process.kill(unrelated.pid, 0);
      }
      console.log(
        JSON.stringify({
          event: 'uninstalled',
          backend: isRust ? 'rust' : 'node',
          keepData: keep,
          restoredOfficial: keep,
          manual: !!manual,
          stalePidIgnored: !!stale,
          realRegistryTested: false,
        }),
      );
    },
  );

test('MCP登记黑盒：仅迁移旧node登记，集成开关保留其他配置并使用隔离官方CLI', async (t) => {
  assert.ok(
    process.env.CODEX_EXE && fs.existsSync(process.env.CODEX_EXE),
    'An isolated official native CODEX_EXE is required',
  );
  const before =
    '# user settings\nmodel = "official"\n\n[mcp_servers.keep]\ncommand = "keep-original"\n\n[mcp_servers.api_switcher]\ncommand = "C:/old/node.exe"\nargs = ["C:/old/mcp-server.cjs"]\nstartup_timeout_sec = 45\n';
  const f = await startBackend(t, {
    setup({ root, home, environment }) {
      const native = path.join(
        root,
        process.platform === 'win32' ? 'official-native.exe' : 'official-native',
      );
      fs.copyFileSync(process.env.CODEX_EXE, native);
      fs.chmodSync(native, 0o755);
      environment.CODEX_EXE = native;
      write(path.join(home, 'config.toml'), before);
    },
  });
  const parse = () =>
    require('smol-toml').parse(fs.readFileSync(path.join(f.home, 'config.toml'), 'utf8'));
  if (isRust) {
    assert.equal(parse().mcp_servers.api_switcher.command, path.resolve(rustBinary()));
    assert.deepEqual(parse().mcp_servers.api_switcher.args, ['--mcp']);
    assert.equal(parse().mcp_servers.api_switcher.startup_timeout_sec, 45);
  } else assert.equal(fs.readFileSync(path.join(f.home, 'config.toml'), 'utf8'), before);
  assert.match((await api(f, 'integrate', { enabled: true })).message, /已集成/);
  assert.equal(parse().model, 'official');
  assert.equal(parse().mcp_servers.keep.command, 'keep-original');
  assert.deepEqual(
    parse().mcp_servers.api_switcher.args,
    isRust ? ['--mcp'] : [path.join(project, 'mcp-server.cjs')],
  );
  assert.equal(parse().mcp_servers.api_switcher.startup_timeout_sec, undefined);
  assert.equal((await api(f, 'state')).mcp.installed, true);
  assert.match((await api(f, 'integrate', { enabled: false })).message, /移除集成/);
  assert.equal(parse().mcp_servers.api_switcher, undefined);
  assert.equal(parse().mcp_servers.keep.command, 'keep-original');
  assert.equal(parse().model, 'official');
  assert.ok(
    fs.readFileSync(path.join(f.home, 'config.toml'), 'utf8').startsWith('# user settings\n'),
  );
});

test('更新传输样例对：平台curl参数、中文错误与原始英文诊断不泄露命令', (t) => {
  const { algorithm } = require('./config-blackbox-helpers.cjs');
  const vectors = [
    {
      platform: 'win32',
      quick: true,
      code: 35,
      text: 'curl: (35) schannel: CRYPT_E_REVOCATION_OFFLINE\n',
    },
    { platform: 'darwin', quick: false, code: 28, text: 'curl: (28) Operation timed out\n' },
    {
      platform: 'win32',
      quick: false,
      code: 60,
      text: 'curl: (60) SSL certificate verify failed\n',
    },
    { platform: 'darwin', quick: true, code: 7, text: 'curl: (7) Failed to connect\n' },
  ];
  const actual = vectors.map((v) =>
    algorithm(
      t,
      {
        op: 'updateTransport',
        ...v,
        stderr: Buffer.concat([
          Buffer.from(v.text),
          Buffer.from([0xce, 0xde, 0xb7, 0xa8]),
        ]).toString('base64'),
      },
      { HTTPS_PROXY: 'http://127.0.0.1:9' },
    ),
  );
  const golden = path.join(__dirname, 'fixtures/update-transport.json');
  if (process.env.SWITCHER_RECORD_TRANSPORT === '1' && !isRust)
    write(golden, JSON.stringify(actual, null, 2) + '\n');
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(golden, 'utf8')));
  for (const r of actual) {
    assert.equal(JSON.stringify(r).includes('PRIVATE-PATH'), false);
    assert.equal(r.args.includes('--insecure'), false);
    assert.equal(r.args.includes('-k'), false);
  }
});

test('更新黑盒：无效包清单拒绝且安装目录和外层文件全文不变', { timeout: 90000 }, async (t) => {
  const f = await packageFixture(t);
  const outer = path.join(f.root, 'outside.txt');
  write(outer, 'outside stays');
  await packageArchive(f, (source) => {
    const file = path.join(source, 'release-files.json'),
      files = JSON.parse(fs.readFileSync(file));
    files.push('../outside.txt');
    write(file, JSON.stringify(files));
  });
  const before = snapshot(f.target);
  await api(f, 'checkUpdate', {});
  await api(f, 'installUpdate', {});
  await failed(f, /无效文件路径/);
  assert.deepEqual(snapshot(f.target), before);
  assert.equal(fs.readFileSync(outer, 'utf8'), 'outside stays');
});

test('更新黑盒：代理不可达时页面明确给地址，日志和页面无代理密码', async (t) => {
  const f = await packageFixture(t, {
    setup({ environment }) {
      for (const key of [
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'http_proxy',
        'https_proxy',
        'all_proxy',
      ])
        environment[key] = 'http://fixture-user:fixture-password@127.0.0.1:9';
      environment.NO_PROXY = '';
      environment.no_proxy = '';
    },
  });
  f.environment.NO_PROXY = '';
  f.environment.no_proxy = '';
  f.response.metadata = metadata(f);
  const result = await api(f, 'checkUpdate', {});
  assert.equal(result.status, 'error');
  assert.match(result.error, /连不上系统代理 http:\/\/127.0.0.1:9/);
  const log = fs.readFileSync(path.join(f.bridge, 'logs/switcher.log'), 'utf8');
  for (const content of [JSON.stringify(result), log]) {
    assert.ok(!content.includes('fixture-password'));
    assert.ok(!content.includes('fixture-user'));
  }
  assert.equal(f.requests.length, 0);
});
