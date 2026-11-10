'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const project = path.resolve(__dirname, '..');
const reportFile = path.join(project, 'verification', 'macos-package.json');
const report = {
  platform: process.platform,
  arch: process.arch,
  runNumber: process.env.MAC_PACKAGE_RUN_NUMBER || process.env.GITHUB_RUN_NUMBER || null,
  packageSequence: Number(process.env.GITHUB_RUN_NUMBER),
  checks: ['install-real-package', 'start-installed-app-and-web',
    'cli-status-restore-cleanup', 'mcp-initialize-and-tool-list',
    'synthetic-macos-keychain-login', 'official-rc3-one-click-upgrade']
    .map((name) => ({ name, passed: null, status: 'not_run' })),
  cleanup: [],
};
const contexts = [];
const children = new Set();
let root, activeCheck, staticServer, temporaryKeychain, originalSearch;
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const exists = fs.existsSync;
const security = (...args) => exec('/usr/bin/security', args, process.env);

function exec(executable, args, env, timeout = 30000) {
  const run = cp.spawnSync(executable, args, { env, encoding: 'utf8', timeout });
  if (run.error || run.status !== 0) {
    // Never include argv: security arguments contain synthetic credential data.
    throw Error(`${path.basename(executable)} exited ${run.status}: ${run.error?.message || ''} ${(run.stderr || '').slice(-2000)}`);
  }
  return run.stdout.trim();
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function until(label, action, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await action();
    if (result) return result;
    await pause();
  }
  throw Error(`${label} timed out after ${timeout}ms`);
}

async function check(name, action) {
  const row = report.checks.find((row) => row.name === name);
  Object.assign(row, { passed: false, status: 'running', startedAt: new Date().toISOString() });
  activeCheck = name;
  try { Object.assign(row, await action(), { passed: true, status: 'passed' }); }
  catch (error) { row.error = error.message; row.status = 'failed'; throw error; }
  finally { row.finishedAt = new Date().toISOString(); }
}

async function download(url, file) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'codex-switcher-package-validation' },
    signal: AbortSignal.timeout(120000),
  });
  assert.equal(response.status, 200, `Download HTTP ${response.status}: ${url}`);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

function context(name) {
  const home = path.join(root, name);
  const codexHome = path.join(home, '.codex');
  const data = path.join(home, 'Library/Application Support/CodexApiSwitcher');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome,
    BRIDGE_CODEX_HOME: codexHome, BRIDGE_HOME: data,
    BRIDGE_DISCOVERY_DIR: path.join(home, '.codex-api-switcher'),
    BRIDGE_HERMES_HOME: path.join(home, 'no-hermes'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_EXE: path.join(root, 'bin/codex'),
    SWITCHER_TEST_NO_OPEN: '1', NO_PROXY: 'localhost,127.0.0.1,::1',
    TMPDIR: path.join(home, 'tmp'),
  };
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  for (const key of ['SWITCHER_WEB_ROOT', 'SWITCHER_RUST_EXE', 'SWITCHER_BLACKBOX_EXE',
    'BRIDGE_PORT', 'SWITCHER_TEST_UPDATE_ORIGIN']) delete env[key];
  const app = path.join(home, 'Applications/Codex Switcher.app');
  const resources = path.join(app, 'Contents/Resources');
  const ctx = { home, codexHome, data, env, app, resources,
    exe: path.join(resources, 'codex-switcher'), runningFile: path.join(data, 'running.json'),
    pids: new Set(), running: null };
  contexts.push(ctx);
  return ctx;
}

function unpack(archive, label) {
  const destination = path.join(root, label);
  fs.mkdirSync(destination);
  exec('/usr/bin/ditto', ['-xk', archive, destination]);
  assert.ok(exists(path.join(destination, 'Install.command')), 'Package installer missing');
  assert.ok(exists(path.join(destination, 'Codex Switcher.app/Contents/MacOS/CodexSwitcher')));
  return destination;
}

function metadata(resources) {
  const current = path.join(resources, 'release-info.json');
  // The official rc.3 predates moving metadata to the package root.
  return read(exists(current) ? current : path.join(resources, 'src/platform/release-info.json'));
}

function build(ctx) { return JSON.parse(exec(ctx.exe, ['--build-info'], ctx.env)); }

function install(source, ctx) {
  exec('/bin/bash', [path.join(source, 'Install.command'), '--no-open'], ctx.env);
  assert.ok(exists(ctx.exe), 'Installed Rust executable missing');
  fs.accessSync(ctx.exe, fs.constants.X_OK);
  const entry = path.join(ctx.app, 'Contents/MacOS/CodexSwitcher');
  fs.accessSync(entry, fs.constants.X_OK);
  assert.equal(exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable',
    path.join(ctx.app, 'Contents/Info.plist')]), 'CodexSwitcher');
  const bundled = path.join(source, 'Codex Switcher.app/Contents/Resources');
  assert.deepEqual(metadata(ctx.resources), metadata(bundled));
  const version = read(path.join(bundled, 'package.json')).version;
  assert.equal(read(path.join(ctx.resources, 'package.json')).version, version);
  assert.equal(exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString',
    path.join(ctx.app, 'Contents/Info.plist')]), version);
  assert.equal(build(ctx).version, version);
  assert.equal(build(ctx).sequence, metadata(ctx.resources).sequence);
  assert.equal(sha(ctx.exe), sha(path.join(bundled, 'codex-switcher')));
}

async function start(ctx) {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  ctx.env.BRIDGE_PORT = String(reservation.address().port);
  await new Promise((resolve) => reservation.close(resolve));
  // Execute the installed native .app entry, which invokes its packaged launcher.
  // No LaunchServices or runner's default HOME/config is involved.
  exec(path.join(ctx.app, 'Contents/MacOS/CodexSwitcher'), ['--no-open'], ctx.env);
  await until('Installed .app backend ready', async () => {
    if (!exists(ctx.runningFile)) return false;
    const running = read(ctx.runningFile);
    assert.ok(Number.isSafeInteger(running.pid) && running.pid > 0);
    ctx.pids.add(running.pid);
    ctx.running = running;
    const response = await request(ctx, '/api/runtime');
    if (!response.ok) return false;
    const runtime = await response.json();
    assert.equal(runtime.id, running.build.id);
    return true;
  });
  return ctx.running;
}

function request(ctx, route, body) {
  const url = new URL(ctx.running.url);
  return fetch(url.origin + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + url.hash.slice(1),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}

async function api(ctx, action, body) {
  const response = await request(ctx, '/api/' + action, body);
  const value = await response.json();
  assert.equal(response.status, 200, value.error || `API ${action} HTTP ${response.status}`);
  return value;
}

async function stop(ctx) {
  if (!ctx.running || !alive(ctx.running.pid)) return;
  await api(ctx, 'quit', {});
  await until('Packaged backend quit', () => !alive(ctx.running.pid));
}

async function mcp(ctx) {
  const child = cp.spawn(ctx.exe, ['--mcp'], { env: ctx.env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  const replies = new Map(); let stdout = '', stderr = '', protocolError;
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.on('error', (error) => { protocolError = error; });
  child.stdin.on('error', (error) => { protocolError = error; });
  const reply = (id) => {
    if (protocolError) throw protocolError;
    if (!replies.has(id) && (child.exitCode !== null || child.signalCode !== null)) {
      throw Error(`MCP exited before response ${id}: ${stderr}`);
    }
    return replies.get(id);
  };
  child.stdout.on('data', (data) => {
    stdout += data;
    let newline;
    while ((newline = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line); if (value.id !== undefined) replies.set(value.id, value);
      } catch (error) { protocolError = Error('MCP emitted invalid JSON: ' + error.message); }
    }
  });
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-2000); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'mac-package-validation', version: '1' } } }) + '\n');
  try {
    const initialized = await until('MCP initialize', () => reply(1));
    assert.ok(initialized.result?.serverInfo, initialized.error?.message || stderr);
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n');
    const listed = await until('MCP tools/list', () => reply(2));
    assert.ok(Array.isArray(listed.result?.tools), listed.error?.message || stderr);
    const tools = listed.result.tools.map((tool) => tool.name);
    assert.ok(tools.includes('list_api_configs'));
    return { protocolVersion: initialized.result.protocolVersion, tools };
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill('SIGTERM');
    await closed; children.delete(child);
  }
}

async function localOrigin(candidate, release) {
  staticServer = http.createServer((req, res) => {
    if (req.url === '/release.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(release)); return;
    }
    if (req.url === '/' + path.basename(candidate)) {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': fs.statSync(candidate).size });
      fs.createReadStream(candidate).pipe(res); return;
    }
    res.writeHead(404); res.end();
  });
  staticServer.listen(0, '127.0.0.1'); await once(staticServer, 'listening');
  return 'http://127.0.0.1:' + staticServer.address().port;
}

async function validate() {
  assert.equal(process.platform, 'darwin', 'Run this package acceptance on macOS');
  assert.ok(['arm64', 'x64'].includes(process.arch), 'Unsupported architecture');
  assert.ok(exists(process.env.CODEX_EXE || ''), 'Official CODEX_EXE from ci-setup.cjs required');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-mac-package-'));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.copyFileSync(process.env.CODEX_EXE, path.join(root, 'bin/codex'));
  fs.chmodSync(path.join(root, 'bin/codex'), 0o755);
  const candidate = path.join(project, 'dist', `codex-switcher-macos-${process.arch}.zip`);
  assert.ok(exists(candidate), 'Build the architecture-specific package first');
  const source = unpack(candidate, 'candidate');
  const current = context('new-package-home');
  fs.writeFileSync(path.join(current.codexHome, 'config.toml'), 'model="package-fixture"\n');
  let incoming;
  await check('install-real-package', async () => {
    install(source, current); incoming = build(current);
    assert.equal(incoming.sequence, report.packageSequence);
    return { version: incoming.version, sequence: incoming.sequence, build: incoming.id,
      installedEntry: 'HOME/Applications/Codex Switcher.app/Contents/MacOS/CodexSwitcher',
      separateDesktopAlias: false, packageSha256: sha(candidate) };
  });
  await check('start-installed-app-and-web', async () => {
    const running = await start(current);
    const response = await request(current, '/');
    assert.equal(response.status, 200);
    const state = await api(current, 'state');
    assert.equal(state.current.model, 'package-fixture');
    assert.equal(state.build.id, incoming.id);
    return { pid: running.pid, port: new URL(running.url).port, httpStatus: response.status };
  });
  await stop(current);
  await check('cli-status-restore-cleanup', async () => {
    const config = path.join(current.codexHome, 'config.toml');
    const original = '# retained fixture comment\nmodel="official-fixture"\n';
    fs.writeFileSync(path.join(current.data, 'original-config.toml'), original);
    fs.writeFileSync(config, '# retained fixture comment\nmodel="api-fixture"\nmodel_provider="hermes_bridge"\n[model_providers.hermes_bridge]\nname="fixture"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\nexperimental_bearer_token="not-a-real-key"\n');
    const before = exec(current.exe, ['--cli', 'status'], current.env);
    assert.equal(before, 'BRIDGED');
    const restored = exec(current.exe, ['--cli', 'restore'], current.env);
    assert.equal(exec(current.exe, ['--cli', 'status'], current.env), 'OFFICIAL');
    assert.match(fs.readFileSync(config, 'utf8'), /model\s*=\s*"official-fixture"/);
    const cleaned = exec(current.exe, ['--cli', 'cleanup'], current.env);
    assert.doesNotMatch(fs.readFileSync(config, 'utf8'), /\[model_providers\.hermes_bridge\]/);
    assert.match(fs.readFileSync(config, 'utf8'), /retained fixture comment/);
    return { before, after: 'OFFICIAL', restoreOutput: restored, cleanupOutput: cleaned };
  });
  await check('mcp-initialize-and-tool-list', () => mcp(current));
  await check('synthetic-macos-keychain-login', async () => {
    const ctx = context('keychain-home'); install(source, ctx);
    fs.writeFileSync(path.join(ctx.codexHome, 'config.toml'), 'cli_auth_credentials_store="keyring"\n');
    originalSearch = security('list-keychains', '-d', 'user').split('\n')
      .map((line) => line.trim().replace(/^"|"$/g, '')).filter(Boolean);
    temporaryKeychain = path.join(root, 'fixture.keychain-db');
    security('create-keychain', '-p', 'fixture-only', temporaryKeychain);
    security('unlock-keychain', '-p', 'fixture-only', temporaryKeychain);
    const storeKey = 'cli|' + crypto.createHash('sha256').update(fs.realpathSync(ctx.codexHome))
      .digest('hex').slice(0, 16);
    const token = 'fixture.' + Buffer.from(JSON.stringify({ email: 'keychain@example.test',
      exp: 4102444800, 'https://api.openai.com/auth': { chatgpt_user_id: 'fixture-user' } }))
      .toString('base64url') + '.not-a-real-signature';
    const credentials = { auth_mode: 'chatgpt', tokens: { account_id: 'fixture-keychain',
      access_token: token, id_token: token, refresh_token: 'not-a-real-refresh-token' },
      last_refresh: '2026-01-01T00:00:00Z' };
    security('add-generic-password', '-s', 'Codex Auth', '-a', storeKey,
      '-w', JSON.stringify(credentials), '-T', '/usr/bin/security', temporaryKeychain);
    security('list-keychains', '-d', 'user', '-s', temporaryKeychain, ...originalSearch);
    await start(ctx);
    const accounts = await api(ctx, 'accounts', {});
    const found = accounts.items.some(
      (item) => item.current && item.email === 'keychain@example.test',
    );
    if (!found) {
      // Match the backend's command, store key and environment. stdout contains
      // the synthetic credential, so retain only its exit status and presence.
      const probe = (env) => {
        const result = cp.spawnSync('/usr/bin/security', [
          'find-generic-password', '-s', 'Codex Auth', '-a', storeKey, '-w',
        ], { env, encoding: 'utf8', timeout: 10000 });
        return {
          exitCode: result.status,
          read: result.status === 0 && Boolean(result.stdout?.trim()),
          signal: result.signal,
          errorCode: result.error?.code ?? null,
        };
      };
      const diagnostics = {
        accounts: accounts.items.map(({ email, current }) => ({ email, current })),
        notice: accounts.credentialsNotice ?? null,
        securityBackendEnv: probe(ctx.env),
        securityScriptEnv: probe(process.env),
      };
      report.checks.find((row) => row.name === activeCheck).diagnostics = diagnostics;
      assert.fail('Synthetic keychain account missing from Rust account summaries: '
        + JSON.stringify(diagnostics));
    }
    assert.equal(exists(path.join(ctx.codexHome, 'auth.json')), false);
    await stop(ctx);
    return { email: 'keychain@example.test', currentAccountRead: true, authFileCreated: false };
  });
  await check('official-rc3-one-click-upgrade', async () => {
    const asset = `codex-switcher-macos-${process.arch}.zip`;
    const base = 'https://github.com/zengjiahao-1322/codex-switcher-demo/releases/download/v0.1.7-rc.3/';
    const archive = path.join(root, 'official-rc3.zip');
    const checksum = archive + '.sha256';
    await download(base + asset, archive); await download(base + asset + '.sha256', checksum);
    const line = fs.readFileSync(checksum, 'utf8').trim();
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    assert.ok(match, 'Official checksum format invalid');
    assert.equal(match[2], asset); assert.equal(sha(archive), match[1].toLowerCase());
    const oldSource = unpack(archive, 'official-rc3');
    const old = context('upgrade-home'); install(oldSource, old);
    fs.writeFileSync(path.join(old.codexHome, 'config.toml'), 'model="upgrade-fixture"\n');
    const previous = build(old);
    assert.equal(previous.version, '0.1.7-rc.3'); assert.ok(incoming.sequence > previous.sequence);
    const commit = process.env.GITHUB_SHA || exec('git', ['rev-parse', 'HEAD']);
    const origin = await localOrigin(candidate, { version: incoming.version, build: incoming.id,
      sequence: incoming.sequence, commit, publishedAt: new Date().toISOString(),
      notes: 'Isolated Mac package upgrade validation', assets: { [asset]: sha(candidate) } });
    old.env.SWITCHER_TEST_UPDATE_ORIGIN = origin;
    const running = await start(old); const oldPid = running.pid;
    await api(old, 'checkUpdate', {}); await api(old, 'installUpdate', {});
    const resultFile = path.join(old.data, 'updates/result.json');
    const next = await until('Official rc.3 replacement and health check', () => {
      if (exists(resultFile)) {
        const receipt = read(resultFile); if (receipt.error) throw Error(receipt.error);
        if (receipt.status !== 'done') return false;
      } else return false;
      if (!exists(old.runningFile)) return false;
      const value = read(old.runningFile); old.pids.add(value.pid);
      return value.build.id === incoming.id && value;
    }, 90000);
    old.running = next;
    assert.notEqual(next.pid, oldPid); await until('Old package PID exit', () => !alive(oldPid));
    const runtime = await api(old, 'runtime');
    assert.equal(runtime.id, incoming.id); assert.equal(runtime.version, incoming.version);
    assert.equal(runtime.sequence, incoming.sequence);
    assert.deepEqual(metadata(old.resources), metadata(current.resources));
    assert.equal(sha(old.exe), sha(current.exe));
    return { from: { version: previous.version, sequence: previous.sequence, build: previous.id },
      to: { version: runtime.version, sequence: runtime.sequence, build: runtime.id },
      oldPid, newPid: next.pid, oldPidExited: true, result: read(resultFile),
      officialPackageSha256: sha(archive), installedBinarySha256: sha(old.exe) };
  });
}

function failureDiagnostics() {
  // These files belong only to this run's temporary HOME. Never copy running.url,
  // account files, configuration, environment variables or keychain credentials.
  return contexts.map((ctx) => {
    const result = { context: path.basename(ctx.home) };
    for (const [name, file] of [
      ['running', ctx.runningFile],
      ['update', path.join(ctx.data, 'updates/result.json')],
    ]) {
      if (!exists(file)) { result[name] = { exists: false }; continue; }
      try {
        const value = read(file);
        result[name] = Object.fromEntries(['pid', 'build', 'status', 'error']
          .filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
      } catch (error) { result[name] = { error: error.message }; }
    }
    const file = path.join(ctx.data, 'service-error.log');
    result.serviceErrorLog = exists(file)
      ? fs.readFileSync(file, 'utf8').slice(-4000)
        .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/(https?:\/\/[^\s#]+)#[^\s]+/g, '$1#[redacted]')
        .replace(/fixture\.[\w-]+\.[\w-]+/g, '[synthetic JWT redacted]')
      : null;
    return result;
  });
}

async function cleanup() {
  for (const child of children) {
    try { if (child.exitCode === null) child.kill('SIGTERM'); }
    catch (error) { report.cleanup.push({ item: 'MCP child', error: error.message }); }
  }
  for (const ctx of contexts) {
    try {
      if (exists(ctx.runningFile)) ctx.pids.add(read(ctx.runningFile).pid);
      for (const pid of ctx.pids) {
        if (!Number.isSafeInteger(pid) || pid <= 0 || !alive(pid)) continue;
        const command = exec('/bin/ps', ['-p', String(pid), '-o', 'command=']);
        assert.ok(command.includes(ctx.resources), 'Refusing to stop a PID outside this temporary app');
        process.kill(pid, 'SIGTERM');
        await until('Temporary switcher cleanup', () => !alive(pid), 15000);
      }
    } catch (error) { report.cleanup.push({ item: path.basename(ctx.home), error: error.message }); }
  }
  // Updates spawn a detached copy under this run's staging directory. It is not
  // a direct child of Node, so also reap commands rooted in our exact Temp tree.
  if (root) {
    try {
      const lines = exec('/bin/ps', ['-axo', 'pid=,command=']).split('\n');
      for (const line of lines) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match || !match[2].includes(root + path.sep)
            || !/codex-switcher|MacOS\/CodexSwitcher/.test(match[2])) continue;
        const pid = Number(match[1]);
        if (pid === process.pid || !alive(pid)) continue;
        process.kill(pid, 'SIGTERM');
        await until('Temporary detached worker cleanup', () => !alive(pid), 15000);
      }
    } catch (error) { report.cleanup.push({ item: 'temporary detached workers', error: error.message }); }
  }
  if (originalSearch) {
    try {
      security('list-keychains', '-d', 'user', '-s', ...originalSearch);
      report.keychainSearchRestored = true;
    }
    catch (error) { report.cleanup.push({ item: 'restore keychain search list', error: error.message }); }
  }
  if (temporaryKeychain && exists(temporaryKeychain)) {
    try {
      security('delete-keychain', temporaryKeychain);
      report.temporaryKeychainRemoved = !exists(temporaryKeychain);
    }
    catch (error) { report.cleanup.push({ item: 'delete temporary keychain', error: error.message }); }
  }
  if (staticServer) {
    staticServer.closeAllConnections();
    await new Promise((resolve) => staticServer.close(resolve));
  }
  if (root && !report.cleanup.length) {
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.promises.rm(root, { recursive: true, force: true });
  }
  report.temporaryRootRemoved = !root || !exists(root);
  if (!report.temporaryRootRemoved) report.remainingTemporaryRoot = root;
}

(async () => {
  try { await validate(); report.passed = true; }
  catch (error) {
    report.passed = false;
    report.failedCheck = activeCheck || 'preflight';
    report.error = error.message;
    report.diagnostics = failureDiagnostics();
  }
  finally {
    try { await cleanup(); }
    catch (error) { report.cleanup.push({ item: 'cleanup', error: error.message }); }
    if (report.cleanup.length) report.passed = false;
    report.checkedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  }
  if (!report.passed) process.exitCode = 1;
  console.log(JSON.stringify(report));
})();
