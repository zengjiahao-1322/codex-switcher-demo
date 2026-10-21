const { PROJECT_ROOT } = require('../src/paths.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
test('autostart creates and removes a Startup shortcut that launches the hidden service script', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-startup-'));
  process.env.BRIDGE_STARTUP_DIR = dir;
  try {
    delete require.cache[require.resolve('../src/clients/autostart.cjs')];
    const a = require('../src/clients/autostart.cjs');
    assert.equal(a.status(), false);
    a.enable(PROJECT_ROOT);
    assert.equal(a.status(), true);
    assert.equal(path.dirname(a.linkPath()), dir);
    const lnk = fs.readFileSync(a.linkPath());
    assert.ok(
      process.platform === 'darwin'
        ? lnk.includes(Buffer.from('main.cjs'))
        : lnk.includes(Buffer.from('launch-hidden.vbs', 'utf16le')) ||
            lnk.includes(Buffer.from('launch-hidden.vbs')),
    );
    assert.equal(a.disable(), true);
    assert.equal(a.status(), false);
  } finally {
    delete process.env.BRIDGE_STARTUP_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('launch-hidden.vbs stays ASCII-only (WSH reads scripts with the ANSI code page)', () => {
  const b = fs.readFileSync(path.join(PROJECT_ROOT, 'launch-hidden.vbs'));
  assert.equal([...b].filter((x) => x > 127).length, 0);
});
