const test = require('node:test'),
  assert = require('node:assert/strict');
test('server rejects unauthenticated API calls and cross-origin mutations', async () => {
  const { createServer } = require('./backend.cjs');
  const s = createServer({ token: 'test-capability', getState: () => ({ providers: [] }) });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + s.address().port;
  try {
    assert.equal((await fetch(base + '/api/state')).status, 401);
    const good = await fetch(base + '/api/state', {
      headers: { Authorization: 'Bearer test-capability' },
    });
    assert.equal(good.status, 200);
    assert.deepEqual(await good.json(), { providers: [] });
    assert.equal(
      (
        await fetch(base + '/api/switch', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-capability',
            Origin: 'https://evil.example',
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
      ).status,
      403,
    );
    const hostStatus = await new Promise((resolve, reject) => {
      require('node:http')
        .get(base + '/', { headers: { Host: 'evil.example' } }, (r) => {
          r.resume();
          resolve(r.statusCode);
        })
        .on('error', reject);
    });
    assert.equal(hostStatus, 403);
  } finally {
    s.close();
  }
});

test('启动器 Bearer 建立 Cookie 会话，公开主页和过期网址不能取得会话', async () => {
  const { createServer } = require('./backend.cjs');
  const s = createServer({ token: 'current-token', getState: () => ({ providers: [] }) });
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + s.address().port;
  try {
    const page = await fetch(base + '/');
    await page.text();
    assert.equal(page.headers.get('set-cookie'), null);
    const denied = await fetch(base + '/api/session', { method: 'POST' });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('set-cookie'), null);
    const login = await fetch(base + '/api/session', {
      method: 'POST',
      headers: { Authorization: 'Bearer current-token' },
    });
    assert.equal(login.status, 204);
    const session = login.headers.get('set-cookie');
    assert.match(session, /HttpOnly; SameSite=Strict; Path=\/api\//);
    const headers = { Cookie: session.split(';')[0], Authorization: 'Bearer expired-token' };
    assert.equal((await fetch(base + '/api/state', { headers })).status, 200);
    assert.equal(
      (await fetch(base + '/api/state', { headers: { Cookie: 'unrelated=old' } })).status,
      401,
    );
    assert.equal(
      (
        await fetch(base + '/api/state', {
          headers: { ...headers, Origin: 'https://elsewhere.example' },
        })
      ).status,
      403,
    );
  } finally {
    await new Promise((resolve) => s.close(resolve));
  }
});
