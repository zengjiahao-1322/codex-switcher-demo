'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { startBackend } = require('./backend-process.cjs');
async function accounts(f) {
  const response = await f.api('accounts', {});
  const value = await response.json();
  if (response.status !== 200) throw Error(JSON.stringify(value));
  return value;
}

function auth(user, options = {}) {
  const jwt = (p) =>
    'fixture.' + Buffer.from(JSON.stringify(p)).toString('base64url') + '.signature';
  return {
    auth_mode: 'chatgpt',
    tokens: {
      account_id: options.workspace || 'workspace-' + user,
      access_token: jwt({
        exp: options.exp ?? Math.floor(Date.now() / 1000) + 3600,
        'https://api.openai.com/auth': {
          chatgpt_user_id: user,
          chatgpt_plan_type: options.plan || 'plus',
        },
      }),
      id_token: jwt({
        email: user + '@example.test',
        'https://api.openai.com/auth': {
          chatgpt_subscription_active_until: '2030-01-01T00:00:00Z',
          chatgpt_subscription_last_checked: '2026-01-01T00:00:00Z',
        },
      }),
      refresh_token: 'fixture-refresh-' + user,
    },
    last_refresh: options.refreshed || '2026-10-27T00:00:00Z',
  };
}
const accountId = (user, workspace = 'workspace-' + user) =>
  crypto
    .createHash('sha256')
    .update(workspace + '\0' + user)
    .digest('hex')
    .slice(0, 20);
async function officialFixture(t, options = {}) {
  let scenarioFile;
  const f = await startBackend(t, {
    setup({ root, home, bridge, environment }) {
      scenarioFile = path.join(root, 'official-scenario.json');
      const scenario = {
        root,
        methods: {
          initialize: { result: {} },
          'account/read': { result: { account: { type: 'chatgpt' } } },
          'account/login/start': {
            result: {
              type: 'chatgpt',
              loginId: 'fixture-login',
              authUrl: 'https://auth.openai.com/fixture-only',
            },
          },
          'account/login/cancel': { result: {} },
          'account/rateLimits/read': {
            result: {
              rateLimits: {
                limitId: 'codex',
                planType: 'plus',
                primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 2000000000 },
              },
            },
          },
        },
        ...options.scenario,
      };
      fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
      environment.SWITCHER_FAKE_CODEX_SCENARIO = scenarioFile;
      environment.SWITCHER_FIXTURE_NODE = process.execPath;
      environment.SWITCHER_FIXTURE_SCRIPT = path.join(
        __dirname,
        'fixtures/fake-official-session.cjs',
      );
      if (options.live)
        fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(options.live, null, 2));
      if (options.setup) options.setup({ root, home, bridge, environment, scenario });
    },
  });
  return {
    ...f,
    scenarioFile,
    update(change) {
      const current = JSON.parse(fs.readFileSync(scenarioFile));
      fs.writeFileSync(scenarioFile, JSON.stringify(change(current) || current));
    },
    rpc() {
      return fs
        .readdirSync(f.root)
        .filter((n) => /^rpc-\d+\.jsonl$/.test(n))
        .flatMap((n) =>
          fs
            .readFileSync(path.join(f.root, n), 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(JSON.parse),
        );
    },
  };
}
async function until(get, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    last = await get();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 20));
  } while (Date.now() < deadline);
  throw Error('Fixture state did not arrive: ' + JSON.stringify(last));
}
module.exports = { auth, accountId, officialFixture, until, accounts };
