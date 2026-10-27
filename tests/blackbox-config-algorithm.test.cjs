'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { isRust, rustBinary } = require('./backend.cjs');
test('双后台样例对：TOML保留未知段并更新受管键', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-toml-vector-'));
  try {
    const input = path.join(root, 'in.json'),
      output = path.join(root, 'out.json');
    const value = {
      op: 'tomlPreserve',
      text: '# keep\nmodel="old"\nother="value"\n[custom]\nkey="x"\n',
      selection: { model: '"new"', model_provider: '"hermes_bridge"' },
      bridge: { name: 'Fixture API' },
    };
    fs.writeFileSync(input, JSON.stringify(value));
    execFileSync(
      isRust ? rustBinary() : process.execPath,
      isRust
        ? ['--algorithm-fixture', input, output]
        : [path.join(__dirname, 'fixtures/diagnostics-algorithm.cjs'), input, output],
    );
    const result = JSON.parse(fs.readFileSync(output));
    assert.match(result, /other="value"/);
    assert.match(result, /\[custom\]/);
    assert.match(result, /model_provider/);
    assert.doesNotMatch(result, /model="old"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
