'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { startBackend } = require('./backend-process.cjs');
const {
  api,
  serve,
  responseTool,
  provider,
  read,
  isolatedEditor,
  finishJob,
} = require('./config-blackbox-helpers.cjs');
test('HTTP backups：deduplicate, keep ten complete copies and restore via isolated job without OAuth changes', async (t) => {
  const f = await startBackend(t);
  await isolatedEditor(t, f);
  fs.writeFileSync(path.join(f.home, 'auth.json'), '{}\n');
  const file = path.join(f.home, 'config.toml');
  for (let i = 0; i < 12; i++) {
    const text = 'model="before-' + i + '"\n';
    for (let repeat = 0; repeat < 2; repeat++) {
      fs.writeFileSync(file, text);
      await api(f, 'switch', { id: 'official', model: 'applied', threadFollow: 'off' });
      assert.equal(read(f), 'model = "applied"\n');
    }
  }
  let items = (await api(f, 'backups', {})).items;
  assert.equal(items.length, 10);
  assert.equal(items[0].summary, '官方 · before-11');
  assert.equal(items.at(-1).summary, '官方 · before-2');
  for (let i = 0; i < 10; i++)
    assert.equal(
      fs.readFileSync(path.join(f.bridge, 'backups/codex-config', items[i].id), 'utf8'),
      'model="before-' + (11 - i) + '"\n',
    );
  const target = items.at(-1).id;
  fs.writeFileSync(file, 'model="current-unsaved"\n');
  await api(f, 'restoreBackup', { id: target, reloadEditors: false, source: 'vscode-local' });
  const job = JSON.parse(fs.readFileSync(path.join(f.bridge, 'account-switch-job.json')));
  assert.equal(job.source, 'vscode-local');
  assert.equal(job.kind, 'restore');
  assert.equal(job.backupId, target);
  assert.equal(job.desktopExe ?? null, null, 'Fixture must never restart a desktop');
  await finishJob(f);
  assert.equal(read(f), 'model="before-2"\n');
  assert.equal(read(f, 'auth.json'), '{}\n');
  items = (await api(f, 'backups', {})).items;
  assert.equal(items.length, 10);
  assert.equal(items[0].reason, 'restore');
  assert.equal(items[0].summary, '官方 · current-unsaved');
  assert.equal(
    fs.readFileSync(path.join(f.bridge, 'backups/codex-config', items[0].id), 'utf8'),
    'model="current-unsaved"\n',
  );
  const events = fs
    .readFileSync(path.join(f.bridge, 'logs/switcher.log'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(events.find((e) => e.event === 'config.restore').status, 'restored');
  assert.ok(events.some((e) => e.event === 'switch.start' && e.job));
  assert.ok(events.some((e) => e.event === 'switch.end' && e.job));
  assert.ok(
    events
      .filter((e) => e.event.startsWith('switch.') && e.job)
      .every((e) => e.source === 'vscode-local'),
  );
});
test('HTTP backups：invalid sources and path ids are rejected with complete disk unchanged', async (t) => {
  const f = await startBackend(t);
  const dir = path.join(f.bridge, 'backups/codex-config');
  fs.mkdirSync(dir, { recursive: true });
  const id = '2026-10-27T11-00-00-000Z-switch.toml',
    text = 'model="backup"\n';
  fs.writeFileSync(path.join(dir, id), text);
  const before = read(f);
  for (const input of [
    { id: '../auth.json' },
    { id: '..\\auth.json' },
    { id: path.join(dir, id) },
    { id: '/etc/config.toml' },
    { id, source: 'unrecognized' },
  ]) {
    await api(f, 'restoreBackup', input, 400);
    assert.equal(read(f), before);
    assert.deepEqual(fs.readdirSync(dir), [id]);
    assert.equal(fs.readFileSync(path.join(dir, id), 'utf8'), text);
    assert.equal(fs.existsSync(path.join(f.bridge, 'account-switch-job.json')), false);
  }
});
test('HTTP backups：restore rebuilds catalog from saved API and model instead of later provider', async (t) => {
  const s = await serve(t, (_, r) => r.end(JSON.stringify(responseTool)));
  const f = await startBackend(t);
  await isolatedEditor(t, f);
  const template = { slug: 'template', visibility: 'list', context_window: 1000 };
  fs.writeFileSync(path.join(f.home, 'models_cache.json'), JSON.stringify({ models: [template] }));
  fs.writeFileSync(
    f.environment.SWITCHER_FAKE_CODEX_RESPONSES,
    JSON.stringify({ initialize: {}, 'model/list': { data: [{ model: 'm' }, { model: 'm2' }] } }),
  );
  const { id } = await api(f, 'providerAdd', { ...provider, baseUrl: s.url });
  await api(f, 'switch', { id, model: 'm', threadFollow: 'off' });
  const expected = read(f),
    catalog = path.join(f.bridge, 'model-catalog.json');
  await api(f, 'switch', { id: 'official', model: 'after', threadFollow: 'off' });
  const saved = (await api(f, 'backups', {})).items.find((i) => i.summary === 'Fixture · m');
  assert.ok(saved);
  fs.writeFileSync(catalog, JSON.stringify({ models: [{ slug: 'other-provider' }] }));
  await api(f, 'restoreBackup', { id: saved.id, reloadEditors: false, source: 'vscode-local' });
  await finishJob(f);
  assert.equal(read(f), expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(catalog)), {
    models: ['m', 'm2'].map((slug, i) => ({
      ...template,
      slug,
      display_name: slug,
      description: 'Fixture · ' + slug,
      priority: i,
      visibility: 'list',
      upgrade: null,
      availability_nux: null,
    })),
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.bridge, 'current.json'))).providerId, id);
});
