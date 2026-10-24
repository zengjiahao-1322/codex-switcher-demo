'use strict';

const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const remote = require('../src/clients/remote-servers.cjs');
const { createRemoteCredentials } = require('../src/accounts/remote-credentials.cjs');

test('远端心跳按已保存账号触发同步，列表查询不触发且不扫描全部账号', async (t) => {
  const bridgeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-remote-credentials-'));
  t.after(() => fs.rmSync(bridgeHome, { recursive: true, force: true }));
  const { writeJson } = require('../src/accounts/accounts.cjs');
  writeJson(path.join(bridgeHome, 'accounts', 'index.json'), [{ id: 'saved-account' }]);
  const auth = {
    tokens: { access_token: 'access', account_id: 'account' },
    last_refresh: '2026-10-24T00:00:00.000Z',
  };
  let statusCalls = 0;
  const accounts = {
    getAuth: (id) => {
      if (id !== 'saved-account') throw Error('账号不存在，请重新选择');
      return auth;
    },
    syncCurrent: async () => {},
    captureCurrent: () => {},
    syncLocalAuth: () => false,
    mergeAuth: () => false,
    status: () => {
      statusCalls++;
      throw Error('不应扫描全部账号');
    },
  };
  t.mock.method(remote, 'groups', () => []);
  const credentials = createRemoteCredentials({ bridgeHome, getAccounts: () => accounts });
  assert.equal(await credentials.synchronize('saved-account'), auth);
  assert.equal(statusCalls, 0);
  assert.equal(await credentials.synchronize('missing-account'), null);

  const observed = [],
    factory = require('../src/accounts/remote-credentials.cjs'),
    clients = require('../src/clients/client-status.cjs');
  t.mock.method(require('../src/accounts/accounts.cjs'), 'createAccounts', () => accounts);
  t.mock.method(factory, 'createRemoteCredentials', (options) => {
    const instance = createRemoteCredentials(options);
    return {
      ...instance,
      observe: (id) => {
        observed.push(id);
        instance.observe(id);
      },
    };
  });
  t.mock.method(clients, 'scanAsync', async () => ({ ancestry: [], processes: [] }));
  t.mock.method(require('../src/platform/runtime.cjs'), 'findCodex', () => process.execPath);
  t.mock.method(require('../src/clients/editor-integration.cjs'), 'editors', () => []);
  const service = require('../src/server/service.cjs').createService({
    bridgeHome,
    codexHome: path.join(bridgeHome, 'codex'),
  });
  await service.actions.clients();
  assert.deepEqual(observed, []);
  await service.actions.clientHeartbeat({
    id: 'remote-sync-window',
    pid: process.pid,
    remoteType: 'ssh-remote',
    remoteAgent: {
      protocol: 2,
      agentVersion: '0.1.4',
      host: 'fixture',
      platform: 'linux',
      arch: 'x64',
      codexHome: '/home/fixture/.codex',
      account: {
        id: 'saved-account',
        email: 'fixture@example.test',
        plan: 'plus',
        lastRefresh: auth.last_refresh,
      },
    },
  });
  await new Promise(setImmediate);
  assert.deepEqual(observed, ['saved-account']);
  assert.equal(statusCalls, 0);
});
