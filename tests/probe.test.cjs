const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
test('probe requires real Responses shape, no auth redirect, and exercises tools', async () => {
  const api = require('../src/server/probe.cjs');
  let body, auth;
  const server = http.createServer(async (req, res) => {
    auth = req.headers.authorization;
    let b = '';
    for await (const c of req) b += c;
    body = JSON.parse(b);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        object: 'response',
        status: 'completed',
        output: [
          { type: 'function_call', name: 'bridge_ping', call_id: 'c1', arguments: '{"ok":true}' },
        ],
      }),
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const result = await api.probe(
      { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-secret' },
      'test',
    );
    assert.equal(result.ok, true);
    assert.equal(result.toolCall, true);
    assert.equal(auth, 'Bearer test-secret');
    assert.equal(body.tools[0].name, 'bridge_ping');
    assert.equal(JSON.stringify(result).includes('test-secret'), false);
  } finally {
    server.close();
  }
});
