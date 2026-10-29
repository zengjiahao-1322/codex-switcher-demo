'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const project = path.resolve(__dirname, '..');
function buildInfo(sequence) {
  const root = path.join(project, 'rust');
  const files = fs
    .readdirSync(path.join(root, 'src'))
    .filter((name) => /\.(rs|c)$/.test(name))
    .map((name) => path.join(root, 'src', name));
  files.push(
    path.join(root, 'build.rs'),
    path.join(project, 'package.json'),
    path.join(root, 'Cargo.toml'),
    path.join(root, 'Cargo.lock'),
    path.join(root, 'src/bin/upgrade-bridge.rs'),
  );
  const hash = crypto.createHash('sha256');
  for (const file of files.sort())
    hash
      .update(path.basename(file))
      .update('\0')
      .update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  const sourceId = hash.digest('hex').slice(0, 12);
  return {
    version: require('../package.json').version,
    id: crypto
      .createHash('sha256')
      .update(sourceId + ':' + sequence)
      .digest('hex')
      .slice(0, 12),
    sequence,
  };
}
module.exports = { buildInfo };
