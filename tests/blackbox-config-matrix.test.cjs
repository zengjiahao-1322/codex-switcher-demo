'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { startBackend } = require('./backend-process.cjs');
const provider = {
  name: 'Mine',
  baseUrl: 'https://api.example.com/v1/',
  apiMode: 'responses',
  models: 'a, b，c',
  model: 'b',
  apiKey: 'sk-1',
};
const disk = (f) => JSON.parse(fs.readFileSync(path.join(f.bridge, 'providers.json'), 'utf8'));
async function api(f, action, input, status = 200) {
  const r = await f.api(action, input);
  const body = await r.json();
  assert.equal(r.status, status, JSON.stringify(body));
  return body;
}
function hermes(f) {
  const home = f.environment.BRIDGE_HERMES_HOME;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.env'), 'export API_SECRET="hk"\n');
  fs.writeFileSync(
    path.join(home, 'config.yaml'),
    'providers:\n  "custom:h1":\n    name: H1\n    base_url: https://h/v1\n    api_key: ${API_SECRET}\n    api_mode: chat_completions\n    model: m\n    models: [m]\n  "custom:local":\n    name: Local\n    base_url: http://127.0.0.1:8317/v1\n    api_mode: chat_completions\n    model: x\n',
  );
  return home;
}
test('配置对照/providers：add, edit (blank key keeps old), delete custom providers', async (t) => {
  const f = await startBackend(t);
  const { id } = await api(f, 'providerAdd', provider);
  let p = disk(f).providers.find((p) => p.id === id);
  assert.deepEqual(disk(f), {
    providers: [
      {
        ...provider,
        baseUrl: 'https://api.example.com/v1',
        models: ['a', 'b', 'c'],
        id,
        origin: 'custom',
        createdAt: p.createdAt,
      },
    ],
    hermesImported: false,
    skippedHermes: [],
  });
  assert.deepEqual(
    [p.baseUrl, p.model, p.models, p.apiKey],
    ['https://api.example.com/v1', 'b', ['a', 'b', 'c'], 'sk-1'],
  );
  await api(f, 'providerUpdate', { id, name: 'Mine2', apiKey: '' });
  p = disk(f).providers[0];
  assert.deepEqual(disk(f).providers, [
    {
      ...provider,
      name: 'Mine2',
      baseUrl: 'https://api.example.com/v1',
      models: ['a', 'b', 'c'],
      id,
      origin: 'custom',
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    },
  ]);
  assert.deepEqual([p.apiKey, p.name], ['sk-1', 'Mine2']);
  await api(f, 'providerRemove', { id });
  assert.deepEqual(disk(f).providers, []);
  await api(f, 'providerRemove', { id }, 400);
});
test('配置对照/providers：validation rejects bad input and duplicate names', async (t) => {
  const f = await startBackend(t);
  for (const change of [
    { name: '' },
    { baseUrl: 'ftp://x' },
    { baseUrl: 'https://u:p@x/v1' },
    { baseUrl: 'https://x/v1?key=fake' },
    { apiMode: 'nope' },
    { model: '' },
    { apiKey: '' },
    { apiKey: 'a b' },
  ]) {
    await api(f, 'providerAdd', { ...provider, ...change }, 400);
    assert.equal(fs.existsSync(path.join(f.bridge, 'providers.json')), false);
  }
  const { id } = await api(f, 'providerAdd', provider);
  const before = fs.readFileSync(path.join(f.bridge, 'providers.json'));
  await api(f, 'providerAdd', provider, 400);
  await api(f, 'providerUpdate', { id, apiKey: 'a b' }, 400);
  assert.deepEqual(fs.readFileSync(path.join(f.bridge, 'providers.json')), before);
});
test('配置对照/providers：Hermes import copies providers (same ids, keyless allowed); imported ones are fully editable and deletable', async (t) => {
  const f = await startBackend(t);
  hermes(f);
  await api(f, 'importHermes', {});
  assert.deepEqual(
    disk(f).providers.map((p) => [p.id, p.origin, p.apiKey]),
    [
      ['custom:h1', 'hermes', 'hk'],
      ['custom:local', 'hermes', ''],
    ],
  );
  await api(f, 'providerUpdate', { id: 'custom:h1', name: 'H1 改名', model: 'm2' });
  assert.deepEqual([disk(f).providers[0].name, disk(f).providers[0].apiKey], ['H1 改名', 'hk']);
  await api(f, 'providerUpdate', { id: 'custom:local', name: 'Local2' });
  await api(f, 'providerRemove', { id: 'custom:h1' });
  assert.equal(disk(f).providers.length, 1);
});
test('配置对照/providers：auto import runs once and never resurrects deleted entries; manual import brings them back', async (t) => {
  const f = await startBackend(t);
  hermes(f);
  await api(f, 'state');
  await api(f, 'providerRemove', { id: 'custom:h1' });
  await api(f, 'state');
  assert.equal(disk(f).providers.length, 1);
  assert.deepEqual(disk(f).skippedHermes, ['custom:h1']);
  await api(f, 'importHermes', {});
  assert.equal(disk(f).providers.length, 2);
  assert.deepEqual(disk(f).skippedHermes, []);
});
test('配置对照/providers：import renames on name clash with existing custom entry', async (t) => {
  const f = await startBackend(t);
  await api(f, 'providerAdd', { ...provider, name: 'H1' });
  hermes(f);
  await api(f, 'importHermes', {});
  assert.ok(disk(f).providers.some((p) => p.name === 'H1 (2)'));
});
test('配置对照/providers：legacy {custom,hiddenHermes} store is read as custom entries', async (t) => {
  const f = await startBackend(t);
  fs.writeFileSync(
    path.join(f.bridge, 'providers.json'),
    JSON.stringify({
      custom: [{ ...provider, models: ['b'], id: 'bridge:1', name: 'Old' }],
      hiddenHermes: ['custom:h1'],
    }),
  );
  hermes(f);
  const state = await api(f, 'state');
  assert.equal(state.providers[1].source, 'custom');
  assert.equal(
    disk(f).providers.some((p) => p.id === 'custom:h1'),
    false,
  );
  assert.equal(
    disk(f).providers.some((p) => p.id === 'custom:local'),
    true,
  );
});
test('配置对照/core：discover redacts malformed YAML parser diagnostics', async (t) => {
  const f = await startBackend(t);
  const home = f.environment.BRIDGE_HERMES_HOME;
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.yaml'), 'api_key: "fixture-secret');
  const result = await api(f, 'importHermes', {}, 400);
  assert.equal(result.error.includes('fixture-secret'), false);
  assert.equal(fs.existsSync(path.join(f.bridge, 'providers.json')), false);
});
test('配置样例/core：discover resolves dotenv and current provider and removes keys publicly', async (t) => {
  const f = await startBackend(t),
    home = f.environment.BRIDGE_HERMES_HOME;
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.env'), 'API_SECRET="fixture-secret"\n');
  fs.writeFileSync(
    path.join(home, 'config.yaml'),
    'providers:\n  p:\n    name: Local\n    base_url: http://localhost:9000/v1\n    api_key: ${API_SECRET}\n    api_mode: responses\n    model: old\n    models:\n      old: {}\n      new: {}\nmodel:\n  provider: p\n  default: new\n',
  );
  const actual = require('./config-blackbox-helpers.cjs').algorithm(t, {
    op: 'discoverProviders',
    home,
  });
  const p = {
    id: 'p',
    name: 'Local',
    active: true,
    baseUrl: 'http://localhost:9000/v1',
    model: 'new',
    models: ['old', 'new'],
    apiMode: 'responses',
    apiKey: 'fixture-secret',
  };
  const { apiKey, ...publicProvider } = p;
  assert.deepEqual(actual, { providers: [p], public: [publicProvider] });
  assert.equal(JSON.stringify(actual.public).includes(apiKey), false);
});
