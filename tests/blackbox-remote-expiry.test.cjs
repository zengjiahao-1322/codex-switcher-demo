'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { startBackend } = require('./backend-process.cjs');
const { api, serve, responseTool } = require('./config-blackbox-helpers.cjs');
const { until } = require('./official-blackbox-helpers.cjs');
const version = require('../package.json').version;
test(
  '远端过期黑盒：30秒命令超时释放且不重试，安装120秒未激活明确notActive',
  { timeout: 160000 },
  async (t) => {
    const f = await startBackend(t);
    const upstream = await serve(t, (_request, response) =>
      response.end(JSON.stringify(responseTool)),
    );
    const { id: providerId } = await api(f, 'providerAdd', {
      name: 'Timeout fixture',
      apiMode: 'responses',
      baseUrl: upstream.url + '/v1',
      apiKey: 'fixture',
      model: 'm',
      models: ['m'],
    });
    await api(f, 'probe', { id: providerId, model: 'm' });
    const registration = (id) => ({
      id,
      pid: process.pid,
      remote: 'ssh-remote+' + id,
      authority: 'ssh-remote+' + id,
      remoteType: 'ssh-remote',
      companionVersion: version,
      remoteProtocol: 1,
      remoteAgent: {
        protocol: 3,
        agentVersion: version,
        host: 'fixture',
        platform: 'linux',
        arch: 'x64',
        codexHome: '/srv/.codex',
        configExists: true,
        startedAt: '2026-10-28T00:00:00Z',
      },
    });
    const waiting = registration('timeout-window'),
      installing = registration('inactive-window');
    await api(f, 'clientHeartbeat', waiting);
    await api(f, 'clientHeartbeat', installing);
    const pending = api(f, 'remoteSwitch', {
      authority: waiting.authority,
      providerId,
      model: 'm',
    });
    const install = api(f, 'installRemoteAgent', { id: installing.id });
    const cmd = (
      await until(
        async () => api(f, 'clientHeartbeat', installing),
        (r) => !!r.command,
      )
    ).command;
    await api(f, 'clientHeartbeat', {
      ...installing,
      ack: cmd.id,
      ackStatus: 'completed',
      ackResult: { installed: true, reload: { method: 'remoteHostExit' } },
    });
    await install;
    const timedOut = await pending;
    assert.equal(timedOut.results[0].status, 'failed');
    assert.match(timedOut.results[0].reason, /超时/);
    assert.equal((await api(f, 'clientHeartbeat', waiting)).command, null);
    const file = path.join(f.bridge, 'clients', installing.id + '.json');
    await until(
      async () => {
        await new Promise((r) => setTimeout(r, 500));
        return JSON.parse(fs.readFileSync(file));
      },
      (row) => row.lastAck.installStatus === 'notActive',
      130000,
    );
    assert.equal((await api(f, 'clientHeartbeat', installing)).reloadConfirmed ?? false, false);
    assert.ok(
      fs.readFileSync(path.join(f.bridge, 'logs/switcher.log'), 'utf8').includes('"notActive"'),
    );
  },
);
