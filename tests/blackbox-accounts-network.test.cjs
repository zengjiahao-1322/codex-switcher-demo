'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { execFile } = require('node:child_process');
const { auth } = require('./official-blackbox-helpers.cjs');
const { isRust, rustBinary } = require('./backend.cjs');
test('会员HTTPS对照：本地TLS真请求校验证书、账号请求头及日期，错误响应不泄露凭证', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-subscription-tls-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bridge = path.join(root, 'bridge');
  fs.mkdirSync(bridge);
  const file = path.join(root, 'auth.json'),
    value = auth('alice');
  fs.writeFileSync(file, JSON.stringify(value));
  const cert = path.join(__dirname, 'fixtures/localhost-test-cert.pem');
  let status = 200,
    body = {
      accounts: {
        'workspace-alice': {
          entitlement: { expires_at: '2030-01-01T00:00:00Z' },
          last_active_subscription: { will_renew: false },
        },
      },
    };
  const requests = [];
  const tlsErrors = [];
  const server = require('node:https').createServer(
    {
      key: fs.readFileSync(path.join(__dirname, 'fixtures/localhost-test-key.pem')),
      cert: fs.readFileSync(path.join(__dirname, 'fixtures/localhost-test-server.pem')),
    },
    (request, response) => {
      requests.push({ url: request.url, headers: request.headers });
      response
        .writeHead(status, { 'content-type': 'application/json' })
        .end(typeof body === 'string' ? body : JSON.stringify(body));
    },
  );
  server.on('tlsClientError', (error) => tlsErrors.push(error.message));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  async function run(trust = true) {
    const input = path.join(root, 'input.json'),
      output = path.join(root, 'output.json');
    fs.writeFileSync(
      input,
      JSON.stringify({
        op: 'subscription',
        authFile: file,
        options: {
          bridgeHome: bridge,
          account: 'alice@example.test',
          endpoint:
            'https://127.0.0.1:' +
            server.address().port +
            '/backend-api/accounts/check/v4-2023-04-27',
          ...(trust ? { caFile: cert } : {}),
        },
      }),
    );
    await new Promise((resolve, reject) =>
      execFile(
        isRust ? rustBinary() : process.execPath,
        isRust
          ? ['--algorithm-fixture', input, output]
          : [path.join(__dirname, 'fixtures/diagnostics-algorithm.cjs'), input, output],
        {
          windowsHide: true,
          env: {
            ...process.env,
            HTTP_PROXY: '',
            HTTPS_PROXY: 'http://127.0.0.1:9',
            ALL_PROXY: '',
            http_proxy: '',
            https_proxy: '',
            all_proxy: '',
            NO_PROXY: '127.0.0.1,localhost',
            no_proxy: '127.0.0.1,localhost',
          },
        },
        (e) => (e ? reject(e) : resolve()),
      ),
    );
    return JSON.parse(fs.readFileSync(output));
  }
  assert.equal(await run(false), null, 'Untrusted test certificate must be rejected');
  assert.equal(requests.length, 0);
  let result = await run();
  assert.ok(
    result,
    JSON.stringify({
      tlsErrors,
      requests: requests.length,
      log: fs.readFileSync(path.join(bridge, 'logs/switcher.log'), 'utf8'),
    }),
  );
  assert.equal(result.until, '2030-01-01T00:00:00Z');
  assert.equal(result.willRenew, false);
  assert.ok(Date.parse(result.checkedAt));
  assert.equal(requests[0].url, '/backend-api/accounts/check/v4-2023-04-27');
  assert.equal(requests[0].headers.authorization, 'Bearer ' + value.tokens.access_token);
  assert.equal(requests[0].headers['chatgpt-account-id'], 'workspace-alice');
  assert.equal(requests[0].headers.originator, 'codex_cli_rs');
  body = {
    accounts: {
      'workspace-alice': {
        entitlement: { renews_at: '2031-01-01T00:00:00Z' },
        last_active_subscription: { will_renew: true },
      },
      'wrong-workspace': { entitlement: { expires_at: '2099-01-01T00:00:00Z' } },
    },
  };
  result = await run();
  assert.equal(result.until, '2031-01-01T00:00:00Z');
  assert.equal(result.willRenew, true);
  for (const pair of [
    [401, 'PRIVATE ' + value.tokens.access_token],
    [200, 'not json SECRET'],
    [
      200,
      { accounts: { 'wrong-workspace': { entitlement: { expires_at: '2099-01-01T00:00:00Z' } } } },
    ],
    [200, { accounts: { 'workspace-alice': { entitlement: { expires_at: 'invalid' } } } }],
  ]) {
    [status, body] = pair;
    assert.equal(await run(), null);
  }
  const log = fs.readFileSync(path.join(bridge, 'logs/switcher.log'), 'utf8');
  assert.doesNotMatch(log, /PRIVATE|SECRET|fixture-refresh/);
  assert.equal(log.includes(value.tokens.access_token), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), value);
});
