'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { api } = require('./config-blackbox-helpers.cjs');
const { officialFixture, accounts, accountId } = require('./official-blackbox-helpers.cjs');
function nativeAuth(user) {
  const payload = {
    sub: user,
    email: user + '@example.test',
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'workspace-' + user,
      chatgpt_user_id: user,
      chatgpt_plan_type: 'plus',
    },
  };
  const jwt =
    'eyJhbGciOiJub25lIn0.' +
    Buffer.from(JSON.stringify(payload)).toString('base64url') +
    '.fixture';
  return {
    auth_mode: 'chatgpt',
    tokens: {
      account_id: 'workspace-' + user,
      access_token: jwt,
      id_token: jwt,
      refresh_token: 'fixture-refresh-' + user,
    },
    last_refresh: new Date().toISOString(),
  };
}
test('官方原生额度HTTP：隔离真实Codex RPC保持慢快账号独立及live全文不变', async (t) => {
  assert.ok(
    process.env.CODEX_EXE && fs.existsSync(process.env.CODEX_EXE),
    'Set CODEX_EXE to an isolated official native runtime; this test never substitutes a fake',
  );
  const requests = [],
    paths = [];
  let releaseSlow;
  const gate = new Promise((r) => {
    releaseSlow = r;
  });
  t.after(() => releaseSlow());
  const upstream = require('node:http').createServer(async (request, response) => {
    paths.push(request.url);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/backend-api/wham/accounts/check') {
      response.end(
        JSON.stringify({
          accounts: ['slow', 'fast'].map((u) => ({
            id: 'workspace-' + u,
            name: u,
            workspace_backend_origin: 'https://chatgpt.com',
            account_routing_override: 'NO_CONSTRAINT',
          })),
          default_account_id: 'workspace-fast',
        }),
      );
      return;
    }
    if (request.url !== '/backend-api/wham/usage') {
      response.writeHead(404).end();
      return;
    }
    const account = request.headers['chatgpt-account-id'];
    requests.push(account);
    if (account === 'workspace-slow') await gate;
    response.end(
      JSON.stringify({
        plan_type: 'plus',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: account === 'workspace-slow' ? 20 : 35,
            limit_window_seconds: 18000,
            reset_after_seconds: 7200,
            reset_at: Math.floor(Date.now() / 1000) + 7200,
          },
          secondary_window: null,
        },
        credits: { has_credits: false, unlimited: false, balance: '0' },
      }),
    );
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const f = await officialFixture(t, {
    live: nativeAuth('slow'),
    setup({ root, environment, scenario }) {
      const exe = path.join(
        root,
        process.platform === 'win32' ? 'official-codex.exe' : 'official-codex',
      );
      fs.copyFileSync(process.env.CODEX_EXE, exe);
      if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
      scenario.native = exe;
      scenario.baseUrl = 'http://127.0.0.1:' + upstream.address().port + '/backend-api';
      fs.writeFileSync(environment.SWITCHER_FAKE_CODEX_SCENARIO, JSON.stringify(scenario));
      environment.NO_PROXY = '127.0.0.1,localhost';
      environment.no_proxy = '127.0.0.1,localhost';
    },
  });
  await accounts(f);
  fs.writeFileSync(path.join(f.home, 'auth.json'), JSON.stringify(nativeAuth('fast')));
  await accounts(f);
  const before = fs.readFileSync(path.join(f.home, 'auth.json'), 'utf8');
  let finished = false;
  const slow = api(f, 'accountQuota', { id: accountId('slow') });
  slow.then(() => {
    finished = true;
  });
  try {
    const fast = await api(f, 'accountQuota', { id: accountId('fast') });
    assert.equal(fast.items[0].status, 'ok', JSON.stringify({ fast, paths }));
    assert.equal(fast.items[0].buckets[0].windows[0].remainingPercent, 65);
    assert.equal(finished, false);
    releaseSlow();
    const result = await slow;
    assert.equal(result.items[0].status, 'ok', JSON.stringify({ result, paths }));
    assert.equal(result.items[0].buckets[0].windows[0].remainingPercent, 80);
    assert.deepEqual(requests.sort(), ['workspace-fast', 'workspace-slow']);
    assert.equal(fs.readFileSync(path.join(f.home, 'auth.json'), 'utf8'), before);
    assert.ok(
      f
        .rpc()
        .filter((c) => c.method === 'account/read')
        .every((c) => c.params.refreshToken === false),
    );
  } finally {
    releaseSlow();
    await slow;
  }
});
