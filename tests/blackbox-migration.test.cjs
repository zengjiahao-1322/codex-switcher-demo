'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startBackend, launchBackend } = require('./backend-process.cjs');
const project = path.resolve(__dirname, '..');
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function hashes(root) {
  const values = {};
  for (const item of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!item.isFile()) continue;
    const file = path.join(item.parentPath, item.name);
    values[path.relative(root, file)] = crypto
      .createHash('sha256')
      .update(fs.readFileSync(file))
      .digest('hex');
  }
  return values;
}
function oldCopy(directory, ids, month, key) {
  write(path.join(directory, 'package.json'), { name: 'codex-api-switcher' });
  write(
    path.join(directory, 'private/accounts/index.json'),
    ids.map((id) => ({ id, label: id })),
  );
  for (const id of ids)
    write(path.join(directory, 'private/accounts', id, 'auth.json'), {
      last_refresh: '2026-' + month + '-01T00:00:00Z',
      credential: 'fixture-' + month + '-' + id,
    });
  write(path.join(directory, 'private/providers.json'), {
    providers: [
      { id: key, name: key, apiKey: 'fixture-' + key },
      { id: 'shared', name: '同名 API', apiKey: 'fixture-' + key },
    ],
    hermesImported: true,
  });
}
async function completed(file) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return read(file);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const log = path.join(path.dirname(file), 'logs/switcher.log');
  throw Error(
    'Migration did not complete: ' +
      file +
      ' ' +
      (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : 'no log'),
  );
}
function setup({ root, home, environment }) {
  const volumes = path.join(root, 'volumes');
  const install = path.join(volumes, 'one');
  for (const relative of require('../release-files.json')) {
    const target = path.join(install, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(project, relative), target);
  }
  fs.symlinkSync(
    path.join(project, 'node_modules'),
    path.join(install, 'node_modules'),
    'junction',
  );
  fs.mkdirSync(path.join(install, 'bin'));
  fs.copyFileSync(
    path.join(project, 'bin/process-context.exe'),
    path.join(install, 'bin/process-context.exe'),
  );
  oldCopy(install, ['a', 'shared'], '01', 'first');
  // Restore the real package metadata after constructing the old-data fixture.
  fs.copyFileSync(path.join(project, 'package.json'), path.join(install, 'package.json'));
  oldCopy(path.join(volumes, 'two'), ['b', 'shared'], '02', 'second');
  oldCopy(path.join(volumes, 'Windows', 'ignored'), ['ignored'], '03', 'ignored');
  write(path.join(install, 'private/settings.json'), { codexHome: home });
  write(path.join(install, 'private/current.json'), { providerId: 'first' });
  write(path.join(install, 'private/backups/local/config.json'), { local: true });
  fs.writeFileSync(path.join(install, 'private/original-config.toml'), 'local-original');
  environment.LOCALAPPDATA = path.join(root, 'local');
  environment.USERPROFILE = root;
  environment.HOME = root;
  environment.BRIDGE_HOME = '';
  environment.BRIDGE_DISCOVERY_DIR = path.join(root, 'discovery');
  fs.mkdirSync(environment.BRIDGE_DISCOVERY_DIR);
  write(path.join(environment.BRIDGE_DISCOVERY_DIR, 'shortcut.json'), {
    created: true,
    sequence: 100000,
  });
  environment.SWITCHER_TEST_SHELL_ROOT = path.join(root, 'shell');
  environment.SWITCHER_TEST_MIGRATION_ROOTS = JSON.stringify([volumes]);
  environment.SWITCHER_BLACKBOX_PROJECT = install;
  environment.SWITCHER_WEB_ROOT = path.join(install, 'web');
}
for (const { legacyDefault, badCopy } of [{}, { legacyDefault: true }, { badCopy: true }]) {
  test(
    badCopy
      ? '双后台黑盒：坏副本记录失败后继续合并好副本，完成标记阻止重启重扫'
      : legacyDefault
        ? '双后台黑盒：seq136传入规范化private时首进程立即迁移'
        : '双后台黑盒：Windows统一目录只读合并旧副本，较新账号与冲突API保留且只迁移一次',
    { skip: process.platform !== 'win32', timeout: 40000 },
    async (t) => {
      let before;
      const f = await startBackend(t, {
        setup(input) {
          setup(input);
          if (badCopy) {
            const bad = path.join(input.root, 'volumes/z-bad');
            oldCopy(bad, ['bad'], '03', 'bad');
            write(path.join(bad, 'private/accounts/index.json'), [{ id: '../invalid' }]);
          }
          if (legacyDefault)
            input.environment.BRIDGE_HOME =
              path.join(input.root, 'volumes/one/private') +
              path.sep +
              '..' +
              path.sep +
              'private' +
              path.sep +
              '.' +
              path.sep;
          before = hashes(path.join(input.root, 'volumes'));
        },
      });
      const data = path.join(f.root, 'local/CodexSwitcher');
      const marker = path.join(data, 'migrated.json');
      const result = await completed(marker);
      assert.equal(result.completed, true);
      assert.equal(result.folders, 2);
      if (badCopy) {
        const failed = result.sources.filter((source) => source.failed);
        assert.equal(failed.length, 1);
        assert.equal(failed[0].path.replace(/\\/g, '/'), '~/volumes/z-bad/private');
        assert.match(failed[0].error, /账号 ID 无效/);
      }
      assert.deepEqual(
        read(path.join(data, 'accounts/index.json'))
          .map((r) => r.id)
          .sort(),
        ['a', 'b', 'shared'],
      );
      assert.equal(
        read(path.join(data, 'accounts/shared/auth.json')).credential,
        'fixture-02-shared',
      );
      const providers = read(path.join(data, 'providers.json')).providers;
      assert.equal(providers.length, 4);
      assert.equal(providers.find((p) => p.id === 'shared').apiKey, 'fixture-first');
      assert.equal(
        providers.find((p) => p.name === '同名 API（来自旧副本）').apiKey,
        'fixture-second',
      );
      for (const name of [
        'settings.json',
        'current.json',
        'backups/local/config.json',
        'original-config.toml',
      ])
        assert.equal(
          fs.readFileSync(path.join(data, name), 'utf8'),
          fs.readFileSync(path.join(f.root, 'volumes/one/private', name), 'utf8'),
        );
      assert.deepEqual(hashes(path.join(f.root, 'volumes')), before);
      const state = await (await f.api('state')).json();
      assert.equal(state.migrated.folders, 2);
      const exportResponse = await f.api('exportDiagnostics', {});
      const diagnostic = await exportResponse.json();
      assert.equal(exportResponse.status, 200, JSON.stringify(diagnostic));
      const header = JSON.parse(diagnostic.text.split('\n---\n')[0]);
      assert.equal(header.installDir.replace(/\\/g, '/'), '~/volumes/one');
      assert.equal(header.dataDir.replace(/\\/g, '/'), '~/local/CodexSwitcher');
      assert.equal(header.migrated.folders, 2);
      assert.ok(!diagnostic.text.includes('fixture-first'));
      const original = fs.readFileSync(marker, 'utf8');
      f.child.kill();
      await f.closed;
      const second = launchBackend(f.environment);
      f.track(second);
      let output = '';
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(Error('Second startup timed out: ' + output)),
          12000,
        );
        second.stdout.on('data', (chunk) => {
          output += chunk;
          if (output.includes('BRIDGE_READY') || output.includes('"event":"ready"')) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      assert.equal(fs.readFileSync(marker, 'utf8'), original);
      assert.equal(
        fs
          .readFileSync(path.join(data, 'logs/switcher.log'), 'utf8')
          .split('\n')
          .filter((line) => line.includes('"event":"data.migrate"')).length,
        1,
      );
      console.log(
        JSON.stringify({
          backend: process.env.SWITCHER_BACKEND || 'node',
          durationMs: result.durationMs,
          cpuMs: result.cpuMs,
          skipped: result.skipped,
          accounts: result.accounts,
          apis: result.apis,
        }),
      );
    },
  );
}
test(
  '双后台黑盒：BRIDGE_HOME覆盖时不运行旧副本迁移',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = await startBackend(t, {
      setup(input) {
        setup(input);
        input.environment.BRIDGE_HOME = input.bridge;
      },
    });
    assert.equal((await (await f.api('state')).json()).migrated, null);
    assert.equal(fs.existsSync(path.join(f.bridge, 'migrated.json')), false);
    assert.equal(fs.existsSync(path.join(f.root, 'local/CodexSwitcher')), false);
  },
);
