const test = require('node:test'),
  assert = require('node:assert/strict');
test('server exposes authenticated adapter route without leaking through UI auth', async () => {
  const { createServer } = require('./backend.cjs');
  let called = false;
  const s = createServer({
    token: 'ui',
    getState: () => ({}),
    adapterToken: 'proxy',
    handleResponses: async (req, res) => {
      called = true;
      res.end('{}');
    },
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + s.address().port;
  try {
    assert.equal(
      (
        await fetch(base + '/v1/responses', {
          method: 'POST',
          headers: { Authorization: 'Bearer ui' },
          body: '{}',
        })
      ).status,
      401,
    );
    const r = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer proxy', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 200);
    assert.equal(called, true);
  } finally {
    s.close();
  }
});
