const test = require('node:test'),
  assert = require('node:assert/strict'),
  http = require('node:http');
const { listModels } = require('../src/server/probe.cjs');
async function serve(fn) {
  const s = http.createServer(fn);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + s.address().port, close: () => s.close() };
}
test('lists OpenAI-style models with bearer key, de-duplicated and sorted', async (t) => {
  let seen;
  const s = await serve((q, r) => {
    seen = { url: q.url, auth: q.headers.authorization };
    r.setHeader('content-type', 'application/json');
    r.end(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }, { id: '' }] }));
  });
  t.after(s.close);
  assert.deepEqual(
    await listModels({ baseUrl: s.url + '/v1/', apiMode: 'chat_completions', apiKey: 'k' }),
    ['a', 'b'],
  );
  assert.deepEqual(seen, { url: '/v1/models', auth: 'Bearer k' });
});
test('lists Anthropic models with x-api-key, /v1 appended and pagination followed', async (t) => {
  const urls = [];
  const s = await serve((q, r) => {
    urls.push(q.url);
    assert.equal(q.headers['x-api-key'], 'ak');
    r.setHeader('content-type', 'application/json');
    const second = q.url.includes('after_id=m1');
    r.end(
      JSON.stringify(
        second
          ? { data: [{ id: 'm2' }], has_more: false }
          : { data: [{ id: 'm1' }], has_more: true, last_id: 'm1' },
      ),
    );
  });
  t.after(s.close);
  assert.deepEqual(
    await listModels({ baseUrl: s.url + '/claude', apiMode: 'anthropic_messages', apiKey: 'ak' }),
    ['m1', 'm2'],
  );
  assert.match(urls[0], /^\/claude\/v1\/models\?/);
  assert.equal(urls.length, 2);
});
test('errors carry HTTP hints, never upstream bodies; redirects refused', async (t) => {
  const s = await serve((q, r) => {
    if (q.url.startsWith('/r')) {
      r.writeHead(302, { location: 'http://127.0.0.1:1/' });
      r.end();
      return;
    }
    r.writeHead(401);
    r.end('secret-body');
  });
  t.after(s.close);
  await assert.rejects(
    listModels({ baseUrl: s.url + '/v1', apiMode: 'chat_completions', apiKey: 'k' }),
    (e) => /HTTP 401：密钥无效/.test(e.message) && !e.message.includes('secret'),
  );
  await assert.rejects(
    listModels({ baseUrl: s.url + '/r', apiMode: 'chat_completions' }),
    /连接失败/,
  );
  await assert.rejects(
    listModels({ baseUrl: 'ftp://x', apiMode: 'chat_completions' }),
    /无效 API 地址/,
  );
});
