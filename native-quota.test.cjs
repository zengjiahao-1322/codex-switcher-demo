'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createAccounts, writeJson } = require('./accounts.cjs');
const { findCodex } = require('./runtime.cjs');

// 使用合成登录记录与本机 HTTP 服务，真实启动官方 Codex app-server。
// 这样可以验证 macOS 的进程、RPC 和网络链路，无需上传任何个人账号。
function fixtureAuth(name) {
  const claims = {
    sub: name,
    email: `${name}@example.test`,
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': {
      chatgpt_account_id: `fixture-${name}`,
      chatgpt_user_id: name,
      chatgpt_plan_type: 'plus',
    },
  };
  const jwt = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
  return {
    auth_mode: 'chatgpt',
    tokens: {
      account_id: `fixture-${name}`,
      access_token: jwt,
      id_token: jwt,
      refresh_token: `fixture-refresh-${name}`,
    },
    last_refresh: new Date().toISOString(),
  };
}

test('native Codex quota RPC keeps slow and fast accounts independent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-native-quota-'));
  const codexHome = path.join(root, 'home');
  const bridgeHome = path.join(root, 'bridge');
  fs.mkdirSync(codexHome);
  fs.mkdirSync(bridgeHome);
  const requests = [];
  const requestPaths = [];
  const rpcErrors = [];
  let releaseSlow;
  const slowGate = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  const upstream = http.createServer(async (request, response) => {
    requestPaths.push(request.url);
    if (request.url === '/backend-api/wham/accounts/check') {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          accounts: ['slow', 'fast'].map((name) => ({
            id: `fixture-${name}`,
            name,
            workspace_backend_origin: 'https://chatgpt.com',
            account_routing_override: 'NO_CONSTRAINT',
          })),
          default_account_id: 'fixture-fast',
        }),
      );
      return;
    }
    // 路径错误必须明确失败，不能让错误请求也拿到成功的额度响应。
    if (request.url !== '/backend-api/wham/usage') {
      response.writeHead(404).end();
      return;
    }
    const account = request.headers['chatgpt-account-id'];
    requests.push(account);
    if (account === 'fixture-slow') await slowGate;
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        plan_type: 'plus',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: account === 'fixture-slow' ? 20 : 35,
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
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/backend-api`;
  const manager = createAccounts({
    codexHome,
    bridgeHome,
    codexExe: findCodex(),
    spawnProcess: (exe, args, options) => {
      const child = spawn(exe, ['-c', `chatgpt_base_url=${JSON.stringify(baseUrl)}`, ...args], {
        ...options,
        env: {
          ...options.env,
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
          http_proxy: '',
          https_proxy: '',
          all_proxy: '',
          NO_PROXY: '127.0.0.1,localhost',
        },
      });
      // 此测试只含合成凭据和本机地址，可以保留 RPC 错误以便定位协议差异。
      require('node:readline')
        .createInterface({ input: child.stdout })
        .on('line', (line) => {
          try {
            const message = JSON.parse(line);
            if (message.error) rpcErrors.push(message.error.message);
          } catch {}
        });
      return child;
    },
  });
  let slowRequest;
  try {
    writeJson(path.join(codexHome, 'auth.json'), fixtureAuth('slow'));
    const slow = manager.status().items.find((row) => row.current);
    writeJson(path.join(codexHome, 'auth.json'), fixtureAuth('fast'));
    const fast = manager.status().items.find((row) => row.current);
    const activeAuth = fs.readFileSync(path.join(codexHome, 'auth.json'));

    let slowFinished = false;
    slowRequest = manager.quota(slow.id);
    slowRequest.then(() => {
      slowFinished = true;
    });
    assert.equal(manager.quota(slow.id), slowRequest, '同一账号不重复启动查询');
    const fastResult = await manager.quota(fast.id);
    assert.equal(
      fastResult.status,
      'ok',
      [fastResult.error, ...rpcErrors, ...requestPaths].filter(Boolean).join('\n'),
    );
    assert.equal(fastResult.buckets[0].windows[0].remainingPercent, 65);
    assert.equal(slowFinished, false, '慢账号仍在等待，不应拖住快账号');

    releaseSlow();
    const slowResult = await slowRequest;
    assert.equal(slowResult.status, 'ok', slowResult.error);
    assert.equal(slowResult.buckets[0].windows[0].remainingPercent, 80);
    assert.deepEqual(requests.sort(), ['fixture-fast', 'fixture-slow']);
    assert.deepEqual(fs.readFileSync(path.join(codexHome, 'auth.json')), activeAuth);
  } finally {
    releaseSlow();
    await slowRequest;
    await new Promise((resolve) => upstream.close(resolve));
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
