'use strict';

// Black-box transport: both backends receive only env/files/HTTP, no JS callbacks.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const project = path.resolve(__dirname, '..');
const { isRust, rustBinary } = require('./backend.cjs');
function launchBackend(environment) {
  return spawn(
    isRust ? environment.SWITCHER_BLACKBOX_EXE || rustBinary() : process.execPath,
    isRust
      ? ['--no-open']
      : [path.join(environment.SWITCHER_BLACKBOX_PROJECT || project, 'main.cjs'), '--no-open'],
    {
      cwd: project,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment,
    },
  );
}

async function startBackend(t, options = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-blackbox-')));
  const home = path.join(root, 'codex'),
    bridge = path.join(root, 'bridge');
  fs.mkdirSync(home);
  fs.mkdirSync(bridge);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model="blackbox-fixture"\n');
  if (options.missingConfig) fs.unlinkSync(path.join(home, 'config.toml'));
  const fake = path.join(root, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  fs.mkdirSync(path.dirname(fake));
  if (process.platform === 'win32') {
    const compiler = path.join(
      process.env.WINDIR || 'C:\\Windows',
      'Microsoft.NET',
      'Framework64',
      'v4.0.30319',
      'csc.exe',
    );
    execFileSync(
      compiler,
      [
        '/nologo',
        '/target:exe',
        '/r:System.Web.Extensions.dll',
        '/out:' + fake,
        path.join(__dirname, 'fixtures', 'fake-codex.cs'),
      ],
      { windowsHide: true, stdio: 'pipe' },
    );
  } else {
    execFileSync('clang', [
      '-O2',
      '-framework',
      'Foundation',
      path.join(__dirname, 'fixtures', 'fake-codex.m'),
      '-o',
      fake,
    ]);
    const helper = path.join(project, 'bin', 'mac-process-context');
    if (!isRust && !fs.existsSync(helper)) {
      fs.mkdirSync(path.dirname(helper), { recursive: true });
      const temporary = helper + '.' + process.pid;
      execFileSync('clang', [
        '-O2',
        '-mmacosx-version-min=12.0',
        path.join(project, 'platform/macos/mac-process-context.c'),
        '-o',
        temporary,
      ]);
      fs.renameSync(temporary, helper);
    }
  }
  const rpcFixture = path.join(root, 'rpc-responses.json');
  fs.writeFileSync(
    rpcFixture,
    JSON.stringify({
      initialize: { capabilities: {} },
      'account/read': { account: { type: 'chatgpt' } },
    }),
  );
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = options.port || reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const environment = {
    ...process.env,
    BRIDGE_HOME: bridge,
    CODEX_HOME: home,
    BRIDGE_CODEX_HOME: home,
    BRIDGE_HERMES_HOME: path.join(root, 'no-hermes'),
    BRIDGE_PORT: String(port),
    SWITCHER_WEB_ROOT: path.join(project, 'web'),
    CODEX_EXE: fake,
    SWITCHER_FAKE_CODEX_RESPONSES: rpcFixture,
    HTTPS_PROXY: 'http://127.0.0.1:9',
    BRIDGE_STARTUP_DIR: path.join(root, 'startup'),
    ...options.environment,
  };
  if (options.setup) await options.setup({ root, home, bridge, environment, fake });
  const child = launchBackend(environment);
  const closed = once(child, 'close');
  const dependents = [];
  const track = (process) => {
    dependents.push({ process, closed: once(process, 'close') });
  };
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  t.after(async () => {
    for (const entry of dependents) {
      if (entry.process.exitCode === null && entry.process.signalCode === null)
        entry.process.kill();
      await entry.closed;
    }
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    if (path.dirname(root) !== fs.realpathSync.native(os.tmpdir()))
      throw Error('Fixture path escaped TEMP');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const ready = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(Error('Backend startup timed out: ' + stderr)), 10000);
    const fail = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
    child.once('error', fail);
    child.once('exit', (code) => fail(Error('Backend exited ' + code + ': ' + stderr)));
    child.stdout.on('data', (data) => {
      output += data;
      if (options.expectReuse && output.includes('BRIDGE_ALREADY_RUNNING')) {
        clearTimeout(timeout);
        resolve(
          JSON.parse(
            fs.readFileSync(path.join(environment.BRIDGE_DISCOVERY_DIR, 'connection.json'), 'utf8'),
          ),
        );
      }
      if (isRust) {
        const line = output
          .split(/\r?\n/)
          .find((line) => line.startsWith('{') && line.includes('"event":"ready"'));
        if (line && output.includes('\n')) {
          clearTimeout(timeout);
          resolve(JSON.parse(line));
        }
      } else if (output.includes('BRIDGE_READY')) {
        clearTimeout(timeout);
        resolve(JSON.parse(fs.readFileSync(path.join(bridge, 'running.json'), 'utf8')));
      }
    });
  });
  const url = new URL(ready.url),
    token = url.hash.slice(1);
  const request = (route, options = {}) => fetch(url.origin + route, options);
  const api = (route, body) =>
    request('/api/' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { root, home, bridge, child, closed, url, token, request, api, environment, track };
}

module.exports = { startBackend, launchBackend };
