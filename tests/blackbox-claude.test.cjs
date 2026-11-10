'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startBackend } = require('./backend-process.cjs');
const { api, serve } = require('./config-blackbox-helpers.cjs');
const provider = (name, baseUrl, apiMode, apiKey, model = 'main') => ({
  name,
  baseUrl,
  apiMode,
  apiKey,
  model,
  models: [model, 'fast'],
});
async function fixture(t) {
  let requests;
  const upstream = await serve(t, (record, response) => {
    requests.push(record);
    response.end(
      JSON.stringify(
        record.url === '/v1/messages'
          ? {
              id: 'msg_direct',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'pong' }],
            }
          : {
              status: 'completed',
              output: [{ type: 'message', content: [{ type: 'output_text', text: 'pong' }] }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
      ),
    );
  });
  requests = upstream.requests;
  const f = await startBackend(t, {
    setup({ root, environment }) {
      const claude = path.join(root, 'claude');
      fs.mkdirSync(claude, { recursive: true });
      fs.writeFileSync(
        path.join(claude, 'settings.json'),
        JSON.stringify({ env: { KEEP: 'yes' }, other: true }),
      );
      environment.CLAUDE_CONFIG_DIR = claude;
    },
  });
  return { ...f, upstream };
}
async function add(f, input) {
  return api(f, 'providerAdd', input);
}
async function state(f) {
  const response = await f.api('state');
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value.claudeCode;
}
test('Claude Code v2 黑盒：直连 apply、模型记忆、provider 同步、restore 与缺钥拒绝', async (t) => {
  const f = await fixture(t);
  const direct = await add(
    f,
    provider('Direct', f.upstream.url + '/v1', 'anthropic_messages', 'direct-key'),
  );
  const before = JSON.parse(
    fs.readFileSync(path.join(f.environment.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'),
  );
  const initial = await state(f);
  assert.equal(initial.current, null);
  const applied = await api(f, 'claudeApply', { id: direct.id, model: 'main', fastModel: 'fast' });
  assert.equal(applied.needsAutostart, false);
  const settings = JSON.parse(
    fs.readFileSync(path.join(f.environment.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'),
  );
  assert.equal(settings.env.ANTHROPIC_BASE_URL, f.upstream.url);
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'direct-key');
  assert.equal(settings.env.ANTHROPIC_MODEL, 'main');
  assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'fast');
  const models = JSON.parse(fs.readFileSync(path.join(f.bridge, 'claude-models.json'), 'utf8'));
  assert.deepEqual(models[direct.id], { model: 'main', fastModel: 'fast' });
  const updated = await api(f, 'providerUpdate', {
    id: direct.id,
    apiKey: 'updated-key',
    baseUrl: f.upstream.url + '/v1',
  });
  assert.match(updated.message, /已同步到 Claude Code/);
  const synchronized = JSON.parse(
    fs.readFileSync(path.join(f.environment.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'),
  );
  assert.equal(synchronized.env.ANTHROPIC_AUTH_TOKEN, 'updated-key');
  await api(f, 'claudeRestore', {});
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(f.environment.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'),
    ),
    before,
  );
  await api(f, 'claudeApply', { id: direct.id, model: 'main', fastModel: 'fast' });
  const settingsBeforeFailedSync = JSON.parse(
    fs.readFileSync(path.join(f.environment.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'),
  );
  settingsBeforeFailedSync.env = 'externally malformed';
  fs.writeFileSync(
    path.join(f.environment.CLAUDE_CONFIG_DIR, 'settings.json'),
    JSON.stringify(settingsBeforeFailedSync),
  );
  const failedSync = await api(f, 'providerUpdate', { id: direct.id, apiKey: 'failed-sync-key' });
  assert.match(failedSync.message, /未能同步/);
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(f.environment.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'),
    ),
    settingsBeforeFailedSync,
  );
  const drifted = await state(f);
  assert.equal(drifted.current, null);
  assert.match(drifted.drift, /外部修改/);
  const empty = JSON.parse(fs.readFileSync(path.join(f.bridge, 'providers.json'), 'utf8'));
  empty.providers.push({
    id: 'missing',
    name: 'Missing',
    baseUrl: 'https://missing.invalid/v1',
    apiMode: 'anthropic_messages',
    apiKey: '',
    model: 'main',
    models: ['main'],
  });
  fs.writeFileSync(path.join(f.bridge, 'providers.json'), JSON.stringify(empty));
  const current = await state(f);
  assert.equal(current.providers.find((p) => p.id === 'missing').reason, '缺少密钥');
  assert.equal(
    (await api(f, 'claudeApply', { id: 'missing', model: 'main' }, 400)).error,
    '请先在 API 配置中填写密钥',
  );
  fs.writeFileSync(path.join(f.environment.CLAUDE_CONFIG_DIR, 'settings.json'), '{"env":,');
  const unreadable = await state(f);
  assert.equal(unreadable.current, null);
  assert.equal(unreadable.drift, 'Claude Code 配置文件无法解析，请检查后重新选择。');
  const removable = await add(
    f,
    provider('Removable', f.upstream.url + '/v1', 'anthropic_messages', 'remove-key'),
  );
  await api(f, 'providerRemove', { id: removable.id });
});
test('Claude Code v2 黑盒：转换 apply 需要保持后台，直连和转换 probe 走正确的上游路径', async (t) => {
  const f = await fixture(t);
  const direct = await add(
    f,
    provider('Direct', f.upstream.url + '/v1', 'anthropic_messages', 'direct-key'),
  );
  const adapter = await add(
    f,
    provider('Adapter', f.upstream.url + '/v1', 'responses', 'adapter-key'),
  );
  const applied = await api(f, 'claudeApply', { id: adapter.id, model: 'main' });
  assert.equal(applied.needsAutostart, true);
  const settings = JSON.parse(
    fs.readFileSync(path.join(f.environment.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'),
  );
  assert.match(settings.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:/);
  const directProbe = await api(f, 'claudeProbe', { id: direct.id, model: 'main' });
  assert.equal(directProbe.ok, true);
  const adapterProbe = await api(f, 'claudeProbe', { id: adapter.id, model: 'main' });
  assert.equal(adapterProbe.ok, true);
  const directRequest = f.upstream.requests.find((request) => request.url === '/v1/messages');
  assert.equal(directRequest.headers['anthropic-version'], '2023-06-01');
  assert.equal(directRequest.body.model, 'main');
  const adapterRequest = f.upstream.requests.find((request) => request.url === '/v1/responses');
  assert.equal(adapterRequest.body.model, 'main');
  assert.ok(
    f.upstream.requests.some(
      (request) =>
        request.url === '/v1/messages' && request.headers.authorization === 'Bearer direct-key',
    ),
  );
  assert.ok(
    f.upstream.requests.some(
      (request) =>
        request.url === '/v1/responses' && request.headers.authorization === 'Bearer adapter-key',
    ),
  );
  const closed = await add(
    f,
    provider('Closed', 'http://127.0.0.1:1/v1', 'anthropic_messages', 'closed-key'),
  );
  const failedProbe = await api(f, 'claudeProbe', { id: closed.id, model: 'main' });
  assert.equal(failedProbe.ok, false);
  assert.doesNotMatch(failedProbe.message, /HTTP/);
  assert.equal((await api(f, 'claudeRestore', {})).restoredTo, 'official');
});
