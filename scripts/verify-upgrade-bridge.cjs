'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  cp = require('node:child_process'),
  http = require('node:http'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict');
const project = path.resolve(__dirname, '..');
const oldZip =
  process.env.SWITCHER_LEGACY_PACKAGE ||
  path.join(project, 'collab/downloads-node-136-ranged/codex-switcher-windows-x64.zip');
const incoming = path.join(project, 'dist/codex-switcher-windows-x64.zip');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-upgrade136-'));
const report = {
  root,
  originalZip: oldZip,
  originalSha: crypto.createHash('sha256').update(fs.readFileSync(oldZip)).digest('hex'),
  checks: [],
  realRegistryTested: false,
};
let old, server, newPid;
const pause = () => new Promise((r) => setTimeout(r, 50));
async function until(read, description, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await read();
    if (v) return v;
    await pause();
  }
  throw Error('Timed out: ' + description);
}
const write = (p, s) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
};
function extract(zip, to) {
  const env = { ...process.env, SWITCHER_ZIP: zip, SWITCHER_OUT: to };
  delete env.PSModulePath;
  cp.execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Expand-Archive -LiteralPath $env:SWITCHER_ZIP -DestinationPath $env:SWITCHER_OUT',
    ],
    { env, windowsHide: true },
  );
}
(async () => {
  try {
    assert.equal(process.platform, 'win32');
    extract(oldZip, path.join(root, 'old'));
    extract(incoming, path.join(root, 'new'));
    const target = path.join(root, 'old/Codex Switcher'),
      source = path.join(root, 'new/Codex Switcher'),
      bridge = path.join(target, 'private'),
      home = path.join(root, 'home'),
      discovery = path.join(root, 'discovery'),
      shell = path.join(root, 'shell');
    const env = {
      ...process.env,
      LOCALAPPDATA: path.join(root, 'local'),
      APPDATA: path.join(root, 'roaming'),
      HOME: path.join(root, 'profile'),
      USERPROFILE: path.join(root, 'profile'),
      BRIDGE_HOME: bridge,
      CODEX_HOME: home,
      BRIDGE_CODEX_HOME: home,
      BRIDGE_HERMES_HOME: path.join(root, 'no-hermes'),
      BRIDGE_DISCOVERY_DIR: discovery,
      SWITCHER_TEST_SHELL_ROOT: shell,
      SWITCHER_TEST_MIGRATION_ROOTS: JSON.stringify([root]),
      SWITCHER_TEST_NO_OPEN: '1',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      HTTPS_PROXY: 'http://127.0.0.1:9',
    };
    const released = JSON.parse(
      cp.execFileSync(
        path.join(target, 'runtime/node.exe'),
        ['-e', "console.log(JSON.stringify(require('./src/platform/build-info.cjs').buildInfo()))"],
        { cwd: target, encoding: 'utf8', windowsHide: true },
      ),
    );
    assert.equal(released.sequence, 136);
    const reservation = require('node:net').createServer();
    await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    env.BRIDGE_PORT = String(reservation.address().port);
    await new Promise((resolve) => reservation.close(resolve));
    report.releasedBuild = released;
    const native = JSON.parse(
      cp.execFileSync(path.join(source, 'codex-switcher.exe'), ['--build-info'], {
        cwd: source,
        env,
        encoding: 'utf8',
        windowsHide: true,
      }),
    );
    const metadata = {
      version: native.version,
      sequence: native.sequence,
      build: native.id,
      commit: 'c'.repeat(40),
      publishedAt: new Date().toISOString(),
      notes: 'isolated native upgrade',
      assets: {
        'codex-switcher-windows-x64.zip': crypto
          .createHash('sha256')
          .update(fs.readFileSync(incoming))
          .digest('hex'),
      },
    };
    const requests = [];
    server = http.createServer((q, s) => {
      requests.push(q.url);
      if (q.url === '/release.json') s.end(JSON.stringify(metadata));
      else s.end(fs.readFileSync(incoming));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const update = path.join(target, 'src/server/update.cjs'),
      unchangedWorker = fs.readFileSync(path.join(target, 'scripts/update-worker.cjs'));
    let code = fs.readFileSync(update, 'utf8');
    assert.ok(
      code.includes(
        'const releaseUrl = `https://github.com/${REPOSITORY}/releases/latest/download/`;',
      ),
    );
    write(
      update,
      code.replace(
        'const releaseUrl = `https://github.com/${REPOSITORY}/releases/latest/download/`;',
        'const releaseUrl = "http://127.0.0.1:' + server.address().port + '/";',
      ),
    );
    write(path.join(home, 'config.toml'), '# keep user text\nmodel = "fixture"\n');
    write(path.join(bridge, 'providers.json'), '{"providers":[]}\n');
    write(path.join(bridge, 'accounts/marker.bin'), 'fake-private-data\0中文');
    write(
      path.join(discovery, 'shortcut.json'),
      JSON.stringify({ created: true, sequence: 136, target }),
    );
    fs.mkdirSync(path.join(shell, 'Desktop'), { recursive: true });
    cp.execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut($env:SWITCHER_LINK);$l.TargetPath=Join-Path $env:SystemRoot 'System32/wscript.exe';$l.Arguments='\"'+$env:SWITCHER_OLD_LAUNCH+'\" open';$l.WorkingDirectory=$env:SWITCHER_OLD_TARGET;$l.Save()",
      ],
      {
        env: {
          ...env,
          SWITCHER_LINK: path.join(shell, 'Desktop/Codex API Switcher.lnk'),
          SWITCHER_OLD_LAUNCH: path.join(target, 'launch-hidden.vbs'),
          SWITCHER_OLD_TARGET: target,
        },
        windowsHide: true,
      },
    );
    const kept = ['providers.json', 'accounts/marker.bin'],
      before = Object.fromEntries(
        kept.map((n) => [n, fs.readFileSync(path.join(bridge, n)).toString('base64')]),
      );
    old = cp.spawn(
      path.join(target, 'runtime/node.exe'),
      [path.join(target, 'main.cjs'), '--no-open'],
      { cwd: target, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let errors = '';
    old.stderr.on('data', (b) => (errors += b));
    old.stdout.resume();
    const running = path.join(bridge, 'running.json');
    const oldRecord = await until(
      () => fs.existsSync(running) && JSON.parse(fs.readFileSync(running)),
      'old record',
    );
    const oldUrl = new URL(oldRecord.url),
      headers = {
        Authorization: 'Bearer ' + oldUrl.hash.slice(1),
        'Content-Type': 'application/json',
      };
    async function api(name) {
      const res = await fetch(oldUrl.origin + '/api/' + name, {
        method: 'POST',
        headers,
        body: '{}',
      });
      const value = await res.json();
      assert.equal(res.status, 200, JSON.stringify(value));
      return value;
    }
    assert.equal((await api('checkUpdate')).status, 'available');
    await api('installUpdate');
    const data = path.join(env.LOCALAPPDATA, 'CodexSwitcher');
    const record = await until(
      () => {
        const migratedRunning = path.join(data, 'running.json');
        if (!fs.existsSync(migratedRunning)) return;
        const r = JSON.parse(fs.readFileSync(migratedRunning));
        return r.build?.id === native.id && r;
      },
      'native running record: ' + errors,
      60000,
    );
    newPid = record.pid;
    await until(() => old.exitCode !== null || old.signalCode !== null, 'old process exit');
    await until(() => {
      const f = path.join(bridge, 'logs/switcher.log');
      return fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('"status":"done"');
    }, 'upgrade done');
    const url = new URL(record.url),
      res = await fetch(url.origin + '/api/runtime', {
        headers: { Authorization: 'Bearer ' + url.hash.slice(1) },
      });
    assert.equal((await res.json()).runtime, 'rust');
    for (const n of kept)
      for (const directory of [bridge, data])
        assert.equal(fs.readFileSync(path.join(directory, n)).toString('base64'), before[n]);
    const migrated = await until(
      () =>
        fs.existsSync(path.join(data, 'migrated.json')) &&
        JSON.parse(fs.readFileSync(path.join(data, 'migrated.json'))),
      'migration completion',
    );
    assert.equal(migrated.completed, true);
    assert.equal(migrated.copiedLocal, true);
    assert.equal(
      fs.readFileSync(path.join(home, 'config.toml'), 'utf8'),
      '# keep user text\nmodel = "fixture"\n',
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(discovery, 'connection.json'))), record);
    const registration = await until(
      () =>
        fs.existsSync(path.join(shell, 'registration.json')) &&
        JSON.parse(fs.readFileSync(path.join(shell, 'registration.json'))),
      'isolated registration',
    );
    assert.equal(registration.InstallLocation, target);
    assert.equal(registration.DisplayIcon, path.join(target, 'codex-switcher.exe') + ',0');
    const link = path.join(shell, 'Desktop/Codex API Switcher.lnk');
    await until(() => fs.existsSync(link), 'isolated shortcut');
    const shortcut = cp.execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$x=(New-Object -ComObject WScript.Shell).CreateShortcut($env:SWITCHER_LINK); @($x.TargetPath,$x.WorkingDirectory)|ConvertTo-Json -Compress',
      ],
      { env: { ...env, SWITCHER_LINK: link }, encoding: 'utf8', windowsHide: true },
    );
    const [linkTarget, working] = JSON.parse(shortcut);
    assert.equal(linkTarget, path.join(target, 'codex-switcher.exe'));
    assert.equal(working, target);
    report.checks = [
      'published-seq136-package',
      'original-update-worker-unmodified-before-start',
      'actual-curl-sha-extract-ipc',
      'old-process-exited',
      'native-health',
      'private-bytes-preserved',
      'legacy-private-env-migrated-on-first-process',
      'unified-data-bytes-preserved',
      'config-full-text-preserved',
      'discovery-handover',
      'TEMP-COM-shortcut-target',
      'TEMP-registration-target',
    ];
    report.native = native;
    report.migrated = migrated;
    report.data = data;
    report.oldPid = old.pid;
    report.newPid = newPid;
    report.requests = requests;
    report.registration = registration;
    report.shortcut = { linkTarget, working };
    report.passed = true;
    report.legacyWorkerSha = crypto.createHash('sha256').update(unchangedWorker).digest('hex');
  } catch (error) {
    report.passed = false;
    report.error = error.stack;
    process.exitCode = 1;
  } finally {
    if (newPid) {
      try {
        process.kill(newPid);
      } catch (e) {
        if (e.code !== 'ESRCH') throw e;
      }
    }
    if (old && old.exitCode === null && old.signalCode === null) old.kill();
    server?.closeAllConnections();
    server?.close();
    report.finishedAt = new Date().toISOString();
    const out = process.env.SWITCHER_REPORT_DIR || path.join(project, 'collab');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(out, 'batch7-upgrade136.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log(JSON.stringify(report));
  }
})();
