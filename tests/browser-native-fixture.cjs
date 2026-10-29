'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process'),
  http = require('node:http');
const project = path.resolve(__dirname, '..');
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
async function prepare(root, home, bridge) {
  const fake = path.join(root, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  if (process.platform === 'win32')
    cp.execFileSync(
      path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      [
        '/nologo',
        '/target:exe',
        '/r:System.Web.Extensions.dll',
        '/out:' + fake,
        path.join(__dirname, 'fixtures/fake-codex.cs'),
      ],
      { windowsHide: true, stdio: 'pipe' },
    );
  else
    cp.execFileSync('clang', [
      '-O2',
      '-framework',
      'Foundation',
      path.join(__dirname, 'fixtures/fake-codex.m'),
      '-o',
      fake,
    ]);
  const scenario = path.join(root, 'rpc-scenario.json');
  const data = {
    root,
    methods: {
      initialize: { result: {} },
      'account/read': { result: { account: { type: 'chatgpt' } } },
      'model/list': {
        result: {
          data: [
            {
              id: 'fixture-api',
              model: 'fixture-api',
              displayName: 'fixture-api',
              supportedInApi: true,
              isDefault: true,
            },
          ],
        },
      },
      'thread/list': { result: { data: [] } },
      'thread/loaded/list': { result: { data: [] } },
    },
    profiles: {},
  };
  write(scenario, data);
  fs.cpSync(path.join(project, 'web'), path.join(root, 'web'), { recursive: true });
  write(path.join(root, 'src/platform/release-info.json'), { sequence: 7 });
  const upstream = http.createServer(async (q, s) => {
    for await (const c of q) {
    }
    s.setHeader('content-type', 'application/json');
    s.end(
      JSON.stringify(
        q.url === '/release.json'
          ? {
              version: '0.1.5',
              build: 'a'.repeat(12),
              sequence: 9,
              commit: 'b'.repeat(40),
              publishedAt: new Date().toISOString(),
              notes: 'fixture notes',
              assets: {
                [process.platform === 'win32'
                  ? 'codex-switcher-windows-x64.zip'
                  : `codex-switcher-macos-${process.arch}.zip`]: 'c'.repeat(64),
              },
            }
          : require('./config-blackbox-helpers.cjs').responseTool,
      ),
    );
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  return {
    data,
    write,
    baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1',
    env: {
      CODEX_EXE: fake,
      SWITCHER_WEB_ROOT: path.join(root, 'web'),
      SWITCHER_FAKE_CODEX_SCENARIO: scenario,
      SWITCHER_FIXTURE_NODE: process.execPath,
      SWITCHER_FIXTURE_SCRIPT: path.join(__dirname, 'fixtures/fake-official-session.cjs'),
      SWITCHER_TEST_UPDATE_ORIGIN: 'http://127.0.0.1:' + upstream.address().port,
      HTTPS_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '127.0.0.1,localhost',
      BRIDGE_STARTUP_DIR: path.join(root, 'startup'),
    },
    save: () => write(scenario, data),
    rpc: () =>
      fs
        .readdirSync(root)
        .filter((n) => /^rpc-\d+\.jsonl$/.test(n))
        .flatMap((n) =>
          fs
            .readFileSync(path.join(root, n), 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(JSON.parse),
        ),
    close: () => {
      upstream.closeAllConnections();
      upstream.close();
    },
  };
}
module.exports = { prepare, write };
