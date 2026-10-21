const test = require('node:test'),
  assert = require('node:assert/strict');
test('server serves a missing static artifact as controlled error not unhandled stream failure', async () => {
  const { createServer } = require('../src/server/server.cjs');
  const fs = require('fs'),
    original = fs.createReadStream;
  fs.createReadStream = () => {
    const s = new (require('stream').PassThrough)();
    process.nextTick(() => s.emit('error', Error('missing')));
    return s;
  };
  const s = createServer({ token: 't', getState: () => ({}) });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch('http://127.0.0.1:' + s.address().port + '/');
    assert.equal(r.status, 500);
  } finally {
    fs.createReadStream = original;
    s.close();
  }
});
