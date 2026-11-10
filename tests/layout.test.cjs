'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const PROJECT_ROOT = path.resolve(__dirname, '..');
test('应用与两份VSIX的版本一致，伴随manifest与package同步', () => {
  const version = require('../package.json').version;
  assert.equal(require('../vscode-companion/package.json').version, version);
  assert.equal(require('../vscode-remote-agent/package.json').version, version);
  const manifest = fs.readFileSync(
    path.join(PROJECT_ROOT, 'vscode-companion/extension.vsixmanifest'),
    'utf8',
  );
  assert.equal(manifest.match(/<Identity[^>]*\bVersion="([^"]+)"/)?.[1], version);
});
