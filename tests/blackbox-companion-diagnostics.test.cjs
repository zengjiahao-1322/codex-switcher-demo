'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { startBackend } = require('./backend-process.cjs');

test(
  'Rust伴随诊断：未安装、禁用、错误发现文件及一次60秒无心跳摘要',
  {
    skip: process.platform !== 'win32',
    timeout: 85000,
  },
  async (t) => {
    const f = await startBackend(t, {
      setup({ root, environment }) {
        environment.USERPROFILE = environment.HOME = path.join(root, 'profile');
        environment.APPDATA = path.join(root, 'appdata');
        environment.LOCALAPPDATA = path.join(root, 'local');
        environment.BRIDGE_DISCOVERY_DIR = path.join(environment.HOME, '.codex-api-switcher');
      },
    });
    const logFile = path.join(f.bridge, 'logs/switcher.log');
    const logs = () => fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    const startup = logs().find((r) => r.event === 'startup');
    assert.equal(startup.companion.editors.length, 4);
    assert.equal(startup.heartbeat.count, 0);
    assert.equal(startup.discovery.matchesSelf, true);
    async function diagnose() {
      const r = await f.api('exportDiagnostics', {});
      assert.equal(r.status, 200);
      const result = await r.json();
      assert.equal(result.text.includes(f.token), false);
      assert.equal(result.text.includes('fixture-discovery-secret'), false);
      return JSON.parse(result.text.split('\n---\n')[0]);
    }
    const missing = await diagnose();
    assert.equal(missing.companion.editors[0].installed, false);
    assert.ok(missing.companion.editors[0].scanError);
    const extensions = path.join(f.environment.HOME, '.vscode/extensions');
    const folder = 'codex-switcher-demo.codex-switcher-companion-0.1.5';
    fs.mkdirSync(path.join(extensions, folder), { recursive: true });
    fs.writeFileSync(
      path.join(extensions, folder, 'package.json'),
      JSON.stringify({ version: '0.1.5' }),
    );
    fs.writeFileSync(
      path.join(extensions, 'extensions.json'),
      JSON.stringify([
        {
          identifier: { id: 'codex-switcher-demo.codex-switcher-companion' },
          relativeLocation: folder,
        },
      ]),
    );
    const database = path.join(f.environment.APPDATA, 'Code/User/globalStorage/state.vscdb');
    fs.mkdirSync(path.dirname(database), { recursive: true });
    const db = new DatabaseSync(database);
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)');
    db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(
      'extensionsIdentifiers/disabled',
      JSON.stringify([{ id: 'codex-switcher-demo.codex-switcher-companion' }]),
    );
    db.close();
    const dbBefore = fs.readFileSync(database);
    const disabled = (await diagnose()).companion.editors[0];
    assert.equal(disabled.installed, true);
    assert.equal(disabled.extensions[0].version, '0.1.5');
    assert.equal(disabled.extensions[0].registered, true);
    assert.equal(disabled.disabled.disabled, true);
    assert.deepEqual(fs.readFileSync(database), dbBefore);
    const discovery = path.join(f.environment.BRIDGE_DISCOVERY_DIR, 'connection.json');
    fs.writeFileSync(
      discovery,
      JSON.stringify({ pid: 987654321, url: 'http://127.0.0.1:32123/#fixture-discovery-secret' }),
    );
    const mismatch = await diagnose();
    assert.equal(mismatch.discovery.matchesSelf, false);
    assert.equal(mismatch.discovery.pid, 987654321);
    assert.equal(mismatch.discovery.port, 32123);
    assert.ok(mismatch.discovery.modifiedAt);
    assert.equal(mismatch.heartbeat.count, 0);
    const fakeCode = path.join(f.root, 'Code.exe');
    fs.copyFileSync(f.environment.CODEX_EXE, fakeCode);
    const code = spawn(fakeCode, [], {
      env: f.environment,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    f.track(code);
    const end = Date.now() + 65000;
    while (!logs().some((r) => r.event === 'companion.silent') && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const silent = logs().filter((r) => r.event === 'companion.silent');
    assert.equal(silent.length, 1);
    assert.ok(silent[0].editors.some((r) => r.pid === code.pid));
    assert.equal(silent[0].companion.editors[0].disabled.disabled, true);
    assert.equal(silent[0].discovery.matchesSelf, false);
    const beat = {
      id: 'diagnostic-window',
      pid: process.pid,
      home: f.home,
      companionVersion: '0.1.5',
      reloadProtocol: 3,
    };
    const response = await f.api('clientHeartbeat', beat);
    assert.equal(response.status, 200);
    const connection = (await response.json()).connection;
    const active = await diagnose();
    assert.equal(active.heartbeat.count, 1);
    assert.ok(active.heartbeat.lastAt);
    assert.deepEqual(active.heartbeat.windows, [
      { id: beat.id, version: '0.1.5', state: connection.state },
    ]);
    assert.equal(logs().filter((r) => r.event === 'companion.silent').length, 1);
    console.log(
      JSON.stringify({
        event: 'companion-diagnostic-cases',
        notInstalled: missing.companion.editors[0],
        disabled,
        wrongDiscovery: mismatch.discovery,
        heartbeat: active.heartbeat,
        silentCount: silent.length,
        silentAt: silent[0].t,
        startupAt: startup.t,
        databaseUnchanged: fs.readFileSync(database).equals(dbBefore),
      }),
    );
  },
);
