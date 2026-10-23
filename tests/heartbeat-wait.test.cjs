'use strict';

const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');

test(
  '进程扫描期间写入的命令不会被长轮询漏掉，确认与完成回报不再挂起',
  { timeout: 3000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-heartbeat-wait-')),
      codexHome = path.join(root, 'codex'),
      bridgeHome = path.join(root, 'bridge');
    fs.mkdirSync(codexHome);
    fs.mkdirSync(bridgeHome);
    t.after(() => {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const clients = require('../src/clients/client-status.cjs'),
      { writeJson } = require('../src/accounts/accounts.cjs');
    let finishScan;
    const scan = new Promise((resolve) => {
      finishScan = resolve;
    });
    t.mock.method(clients, 'scanAsync', () => scan);
    const service = require('../src/server/service.cjs').createService({ codexHome, bridgeHome }),
      input = { id: 'late-command-window', pid: 910, wait: 10000 };
    const pending = service.actions.clientHeartbeat(input, { signal: t.signal });
    const file = path.join(bridgeHome, 'clients', input.id + '.json'),
      row = JSON.parse(fs.readFileSync(file));
    writeJson(file, { ...row, command: { id: 'command-during-scan', type: 'reload' } });
    finishScan({ ancestry: [{ pid: 910, parentPid: 1, name: 'Code' }], processes: [] });
    assert.equal((await pending).command.id, 'command-during-scan');
    const ack = await service.actions.clientHeartbeat(
      {
        ...input,
        ack: 'command-during-scan',
        ackStatus: 'reload_requested',
      },
      { signal: t.signal },
    );
    assert.equal(ack.command, null);
    assert.equal(JSON.parse(fs.readFileSync(file)).lastAck.status, 'reload_requested');
    const completed = await service.actions.clientHeartbeat(
      {
        ...input,
        completedReload: { clientId: input.id, commandId: 'command-during-scan' },
      },
      { signal: t.signal },
    );
    assert.equal(completed.longPoll, true);
    assert.equal(completed.command, null);
  },
);
