'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startBackend } = require('./backend-process.cjs');
test('双后台黑盒：配置增改删、备份列表恢复与非法路径隔离', async (t) => {
  const f = await startBackend(t);
  const input = {
    name: 'Fixture API',
    baseUrl: 'https://fixture.invalid/v1',
    apiMode: 'responses',
    model: 'fixture-model',
    models: ['fixture-model', 'fixture-fast'],
    apiKey: 'fixture-secret',
  };
  let response = await f.api('providerAdd', input);
  assert.equal(response.status, 200, await response.clone().text());
  const id = (await response.json()).id;
  const state = await (await f.api('state')).json();
  assert.equal(state.providers[1].name, 'Fixture API');
  assert.equal(JSON.stringify(state).includes('fixture-secret'), false);
  response = await f.api('providerUpdate', { id, model: 'fixture-fast' });
  assert.equal(response.status, 200, await response.clone().text());
  const backup = path.join(f.bridge, 'backups/codex-config');
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(
    path.join(backup, '2026-10-27T11-00-00-000Z-switch.toml'),
    'model="backup-model"\n',
  );
  const listed = await (await f.api('backups', {})).json();
  assert.equal(listed.items.length, 1);
  assert.equal((await f.api('restoreBackup', { id: '../config.toml' })).status, 400);
  assert.equal((await f.api('providerRemove', { id })).status, 200);
  assert.equal(
    (await f.api('restoreBackup', { id: '2026-10-27T11-00-00-000Z-switch.toml' })).status,
    200,
  );
});
