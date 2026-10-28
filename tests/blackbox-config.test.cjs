'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { startBackend } = require('./backend-process.cjs');
const {
  api,
  serve,
  responseTool,
  provider,
  read,
  interfere,
} = require('./config-blackbox-helpers.cjs');
const original = 'model="official"\n# original\n';
function expected(p, model, body = '# original\n', catalog) {
  return (
    `model = ${JSON.stringify(model)}\nmodel_provider = "hermes_bridge"\n` +
    (catalog ? `model_catalog_json = ${JSON.stringify(catalog)}\n` : '') +
    body +
    bridge(p)
  );
}
function bridge(p) {
  return `[model_providers.hermes_bridge]\nname = "Fixture"\nbase_url = ${JSON.stringify(p.baseUrl)}\nwire_api = "responses"\nexperimental_bearer_token = "fixture-secret"\nrequires_openai_auth = false\n`;
}
async function fixture(t) {
  const s = await serve(t, (_, r) => r.end(JSON.stringify(responseTool)));
  const f = await startBackend(t);
  fs.writeFileSync(path.join(f.home, 'config.toml'), original);
  const p = { ...provider, baseUrl: s.url + '/v1' };
  const { id } = await api(f, 'providerAdd', p);
  return { ...f, p, id };
}
const apply = (f, model = 'm') => api(f, 'switch', { id: f.id, model, threadFollow: 'off' });
test('HTTP core：first snapshot survives repeated switches and restore retains later edits', async (t) => {
  const f = await fixture(t);
  await apply(f, 'first');
  assert.equal(read(f), expected(f.p, 'first'));
  const later = '\n[mcp_servers.later]\ncommand="preserve"\n';
  fs.appendFileSync(path.join(f.home, 'config.toml'), later);
  await apply(f, 'second');
  assert.equal(read(f), expected(f.p, 'second', '# original\n' + later.trimStart()));
  assert.equal(fs.readFileSync(path.join(f.bridge, 'original-config.toml'), 'utf8'), original);
  await api(f, 'restore', { threadFollow: 'off' });
  assert.equal(read(f), 'model = "official"\n# original\n' + later.trimStart() + bridge(f.p));
});
test('HTTP core：concurrent external edit during snapshot aborts without overwriting', async (t) => {
  const f = await fixture(t);
  const large = '#' + 'x'.repeat(2 * 1024 * 1024) + '\n';
  fs.appendFileSync(path.join(f.home, 'config.toml'), large);
  const changed = await interfere(t, f, f.bridge, 'original-config.toml.');
  const result = await api(f, 'switch', { id: f.id, model: 'm', threadFollow: 'off' }, 400);
  assert.equal(await changed(), true);
  assert.match(result.error, /concurrent/i);
  assert.equal(read(f), 'model="external"\n');
});
test('HTTP core：held bridge lock refuses overlapping writer with disk unchanged', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.home, '.hermes-bridge.lock'), 'held');
  assert.match(
    (await api(f, 'switch', { id: 'official', model: 'other', threadFollow: 'off' }, 400)).error,
    /locked/,
  );
  assert.equal(read(f), original);
  assert.equal(fs.existsSync(path.join(f.bridge, 'original-config.toml')), false);
});
test('HTTP core：restore detects an external edit while writing temporary configuration', async (t) => {
  const f = await fixture(t);
  await apply(f);
  fs.appendFileSync(
    path.join(f.home, 'config.toml'),
    '\n[extra]\n#' + 'x'.repeat(2 * 1024 * 1024) + '\n',
  );
  const changed = await interfere(t, f, f.home, 'config.toml.');
  const result = await api(f, 'restore', { threadFollow: 'off' }, 400);
  assert.equal(await changed(), true);
  assert.match(result.error, /concurrent/i);
  assert.equal(read(f), 'model="external"\n');
});
test('HTTP core：private complete snapshot and config preserve OAuth and effect hash', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.home, 'auth.json'), '{}\n');
  await apply(f);
  const value = expected(f.p, 'm');
  assert.equal(read(f), value);
  assert.equal(fs.readFileSync(path.join(f.bridge, 'original-config.toml'), 'utf8'), original);
  assert.equal(read(f, 'auth.json'), '{}\n');
  const backups = (await api(f, 'backups', {})).items;
  assert.equal(backups.length, 1);
  assert.equal(
    fs.readFileSync(path.join(f.bridge, 'backups/codex-config', backups[0].id), 'utf8'),
    original,
  );
  for (const file of [
    path.join(f.home, 'config.toml'),
    path.join(f.bridge, 'original-config.toml'),
  ]) {
    if (process.platform === 'win32') {
      const env = { ...process.env, ACL_TARGET: file };
      delete env.PSModulePath;
      const acl = JSON.parse(
        require('node:child_process').execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            '$a=Get-Acl -LiteralPath $env:ACL_TARGET; [pscustomobject]@{protected=$a.AreAccessRulesProtected;sids=@($a.Access | ForEach-Object {$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value})} | ConvertTo-Json -Compress',
          ],
          { encoding: 'utf8', env, windowsHide: true },
        ),
      );
      assert.equal(acl.protected, true);
      assert.equal(acl.sids.length, 2);
      assert.ok(acl.sids.includes('S-1-5-18'));
    } else assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  const effect = (await api(f, 'state')).effect;
  assert.equal(effect.status, 'restart_required');
  assert.equal(effect.configHash, crypto.createHash('sha256').update(value).digest('hex'));
  fs.appendFileSync(path.join(f.home, 'config.toml'), '# external\n');
  assert.equal((await api(f, 'state')).effect, null);
});
test('HTTP core：snapshot refreshes after an official model change', async (t) => {
  const f = await fixture(t);
  await apply(f);
  await api(f, 'restore', { threadFollow: 'off' });
  const official = 'model="later-official"\n# changed\n';
  fs.writeFileSync(path.join(f.home, 'config.toml'), official);
  await apply(f, 'm2');
  assert.equal(read(f), expected(f.p, 'm2', '# changed\n'));
  assert.equal(fs.readFileSync(path.join(f.bridge, 'original-config.toml'), 'utf8'), official);
  await api(f, 'restore', { threadFollow: 'off' });
  assert.equal(read(f), 'model = "later-official"\n# changed\n' + bridge(f.p));
});
test('HTTP core：unbridged restore is unchanged and missing snapshot returns Chinese error', async (t) => {
  const f = await fixture(t);
  await api(f, 'restore', { threadFollow: 'off' });
  assert.equal(read(f), original);
  const bridged = expected(f.p, 'm');
  fs.writeFileSync(path.join(f.home, 'config.toml'), bridged);
  assert.match((await api(f, 'restore', { threadFollow: 'off' }, 400)).error, /快照/);
  assert.equal(read(f), bridged);
});
test('HTTP core：model catalog selection and full catalog are generated and original restored', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(
    path.join(f.home, 'config.toml'),
    'model="official"\nmodel_catalog_json="C:/mine.json"\n# original\n',
  );
  const template = { slug: 'template', visibility: 'list', context_window: 1000, priority: 1 };
  fs.writeFileSync(path.join(f.home, 'models_cache.json'), JSON.stringify({ models: [template] }));
  fs.writeFileSync(
    f.environment.SWITCHER_FAKE_CODEX_RESPONSES,
    JSON.stringify({
      initialize: { capabilities: {} },
      'model/list': { data: [{ model: 'm' }, { model: 'm2' }] },
    }),
  );
  await apply(f);
  const catalog = path.join(f.bridge, 'model-catalog.json');
  assert.equal(read(f), expected(f.p, 'm', '# original\n', catalog));
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
  await api(f, 'restore', { threadFollow: 'off' });
  assert.equal(
    read(f),
    'model = "official"\nmodel_catalog_json = "C:/mine.json"\n# original\n' + bridge(f.p),
  );
});
