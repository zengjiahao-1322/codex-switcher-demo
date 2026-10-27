'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startBackend } = require('./backend-process.cjs');
const { api, serve, responseTool, provider } = require('./config-blackbox-helpers.cjs');

test('HTTP probe：real Responses shape, bearer auth and function payload', async (t) => {
  const upstream = await serve(t, (q, r) => r.end(JSON.stringify(responseTool)));
  const f = await startBackend(t);
  const { id } = await api(f, 'providerAdd', { ...provider, baseUrl: upstream.url + '/v1' });
  assert.equal((await api(f, 'probe', { id, model: 'm' })).mode, 'direct');
  assert.equal(upstream.requests.length, 1);
  const q = upstream.requests[0];
  assert.deepEqual(
    [q.method, q.url, q.headers.authorization],
    ['POST', '/v1/responses', 'Bearer fixture-secret'],
  );
  assert.equal(q.body.model, 'm');
  assert.equal(q.body.tools[0].name, 'bridge_ping');
  assert.deepEqual(q.body.tools[0].parameters.required, ['ok']);
  assert.equal(q.body.stream, false);
  const state = await api(f, 'state');
  assert.equal(state.providers.find((p) => p.id === id).access.mode, 'direct');
  assert.equal(state.providers.find((p) => p.id === id).local, true);
  assert.equal(JSON.stringify(state).includes('fixture-secret'), false);
  await api(f, 'providerUpdate', { id, apiKey: 'fixture-new' });
  assert.equal((await api(f, 'state')).providers.find((p) => p.id === id).access.mode, 'unknown');
  await api(f, 'probe', { id, model: 'm' });
  await api(f, 'providerUpdate', { id, baseUrl: upstream.url + '/other' });
  assert.equal((await api(f, 'state')).providers.find((p) => p.id === id).access.mode, 'unknown');
  await api(f, 'probe', { id, model: 'm' });
  await api(f, 'providerUpdate', { id, apiMode: 'chat_completions' });
  assert.equal((await api(f, 'state')).providers.find((p) => p.id === id).access.mode, 'unknown');
  const external = await api(f, 'providerAdd', {
    ...provider,
    name: 'External',
    baseUrl: 'https://fixture.invalid/v1',
  });
  assert.equal((await api(f, 'state')).providers.find((p) => p.id === external.id).local, false);
});
test('HTTP probe：reject chat-shaped success, redirects and incomplete output', async (t) => {
  let mode = 'chat',
    stolen = 0;
  const target = await serve(t, (_, r) => {
    stolen++;
    r.end('{}');
  });
  const upstream = await serve(t, (q, r) => {
    if (mode === 'redirect') {
      r.writeHead(302, { location: target.url });
      r.end();
      return;
    }
    r.end(
      JSON.stringify(
        mode === 'chat'
          ? { choices: [{ message: { content: 'ok' } }] }
          : { ...responseTool, status: 'incomplete' },
      ),
    );
  });
  const f = await startBackend(t);
  const { id } = await api(f, 'providerAdd', { ...provider, baseUrl: upstream.url });
  for (mode of ['chat', 'redirect', 'incomplete'])
    assert.equal((await api(f, 'probe', { id, model: 'm' })).ok, false);
  assert.equal(upstream.requests.length, 6);
  assert.equal(stolen, 0);
});
test('HTTP models：OpenAI bearer, deduplication and sorting', async (t) => {
  const s = await serve(t, (_, r) =>
    r.end(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }, { id: '' }] })),
  );
  const f = await startBackend(t);
  assert.deepEqual(
    (await api(f, 'models', { baseUrl: s.url + '/v1/', apiMode: 'chat_completions', apiKey: 'k' }))
      .models,
    ['a', 'b'],
  );
  assert.deepEqual(
    [s.requests[0].url, s.requests[0].headers.authorization],
    ['/v1/models', 'Bearer k'],
  );
});
test('HTTP models：Anthropic x-api-key and pagination', async (t) => {
  const s = await serve(t, (q, r) =>
    r.end(
      JSON.stringify(
        q.url.includes('after_id=m1')
          ? { data: [{ id: 'm2' }], has_more: false }
          : { data: [{ id: 'm1' }], has_more: true, last_id: 'm1' },
      ),
    ),
  );
  const f = await startBackend(t);
  assert.deepEqual(
    (
      await api(f, 'models', {
        baseUrl: s.url + '/claude',
        apiMode: 'anthropic_messages',
        apiKey: 'ak',
      })
    ).models,
    ['m1', 'm2'],
  );
  assert.deepEqual(
    s.requests.map((q) => [q.url, q.headers['x-api-key'], q.headers['anthropic-version']]),
    [
      ['/claude/v1/models?limit=1000', 'ak', '2023-06-01'],
      ['/claude/v1/models?limit=1000&after_id=m1', 'ak', '2023-06-01'],
    ],
  );
});
test('HTTP models/probe：401 hints redact upstream bodies and refuse redirects', async (t) => {
  let stolen = 0;
  const target = await serve(t, (_, r) => {
    stolen++;
    r.end('{}');
  });
  const s = await serve(t, (q, r) => {
    if (q.url.startsWith('/r/')) r.writeHead(302, { location: target.url });
    else r.writeHead(401);
    r.end('upstream-secret-body');
  });
  const f = await startBackend(t);
  const failure = await api(
    f,
    'models',
    { baseUrl: s.url + '/v1', apiMode: 'chat_completions', apiKey: 'k' },
    400,
  );
  assert.match(failure.error, /HTTP 401：密钥无效/);
  assert.equal(failure.error.includes('secret'), false);
  assert.match(
    (await api(f, 'models', { baseUrl: s.url + '/r', apiMode: 'chat_completions' }, 400)).error,
    /连接失败/,
  );
  assert.match(
    (await api(f, 'models', { baseUrl: 'ftp://x', apiMode: 'chat_completions' }, 400)).error,
    /无效 API 地址/,
  );
  const { id } = await api(f, 'providerAdd', { ...provider, baseUrl: s.url });
  const probe = await api(f, 'probe', { id, model: 'm' });
  assert.equal(probe.ok, false);
  assert.match(probe.message, /401/);
  assert.equal(probe.message.includes('secret'), false);
  assert.equal(stolen, 0);
});
test('HTTP probe：Responses rejection falls back to actual Chat function call', async (t) => {
  const s = await serve(t, (q, r) => {
    if (q.url.endsWith('/responses')) {
      r.writeHead(404);
      r.end('{}');
    } else
      r.end(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  { type: 'function', function: { name: 'bridge_ping', arguments: '{"ok":true}' } },
                ],
              },
            },
          ],
        }),
      );
  });
  const f = await startBackend(t);
  const { id } = await api(f, 'providerAdd', {
    ...provider,
    baseUrl: s.url,
    apiMode: 'chat_completions',
  });
  assert.equal((await api(f, 'probe', { id, model: 'm' })).mode, 'adapter');
  assert.deepEqual(
    s.requests.map((q) => q.url),
    ['/responses', '/chat/completions'],
  );
  assert.equal(s.requests[1].body.tools[0].function.name, 'bridge_ping');
  assert.equal(s.requests[1].headers.authorization, 'Bearer fixture-secret');
});
test(
  'HTTP probe：real 45s Responses timeout is surfaced, native 401 remains failure',
  { timeout: 65000 },
  async (t) => {
    const s = await serve(t, (q, r) => {
      if (q.url.endsWith('/chat/completions')) {
        r.writeHead(401);
        r.end('{}');
      }
    });
    const f = await startBackend(t);
    const { id } = await api(f, 'providerAdd', { ...provider, baseUrl: s.url });
    const started = Date.now(),
      result = await api(f, 'probe', { id, model: 'm' });
    assert.equal(result.ok, false);
    assert.match(result.message, /连接超时/);
    assert.ok(Date.now() - started >= 44000);
    assert.deepEqual(
      s.requests.map((q) => q.url),
      ['/responses', '/chat/completions'],
    );
  },
);
