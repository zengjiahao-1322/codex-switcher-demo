'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { execFileSync } = require('node:child_process');
const { isRust, rustBinary } = require('./backend.cjs');
for (const vector of require('./fixtures/config-vectors.json')) {
  test('TOML完整样例：' + vector.name, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-toml-vector-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const input = path.join(root, 'input.json'),
      output = path.join(root, 'output.json');
    fs.writeFileSync(input, JSON.stringify(vector.input));
    execFileSync(
      isRust ? rustBinary() : process.execPath,
      isRust
        ? ['--algorithm-fixture', input, output]
        : [path.join(__dirname, 'fixtures/diagnostics-algorithm.cjs'), input, output],
      { windowsHide: true },
    );
    const actual = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.deepEqual(actual, vector.expected);
    if (actual.error) assert.equal(actual.error.includes('fixture-secret'), false);
    if (actual.text && (vector.input.method || 'prepare') === 'prepare') {
      fs.writeFileSync(input, JSON.stringify({ ...vector.input, text: actual.text }));
      execFileSync(
        isRust ? rustBinary() : process.execPath,
        isRust
          ? ['--algorithm-fixture', input, output]
          : [path.join(__dirname, 'fixtures/diagnostics-algorithm.cjs'), input, output],
        { windowsHide: true },
      );
      assert.deepEqual(
        JSON.parse(fs.readFileSync(output, 'utf8')),
        actual,
        'Repeating selection must be idempotent',
      );
    }
  });
}
