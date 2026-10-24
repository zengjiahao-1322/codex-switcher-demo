'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');

const [tag, artifactDir, output] = process.argv.slice(2);
if (!tag || !artifactDir || !output)
  throw Error('用法：create-release-json.cjs <tag> <artifactDir> <output>');
const sequence = Number(process.env.GITHUB_RUN_NUMBER);
if (!Number.isSafeInteger(sequence) || sequence <= 0)
  throw Error('GITHUB_RUN_NUMBER 必须为正整数，用作发行序号。');
const assets = {};
for (const name of fs.readdirSync(artifactDir).sort()) {
  if (name.endsWith('.sha256')) continue;
  const file = path.join(artifactDir, name);
  if (!fs.statSync(file).isFile()) continue;
  assets[name] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
const release = {
  version: require('../package.json').version,
  build: require('../src/platform/build-info.cjs').buildInfo(sequence).id,
  sequence,
  commit:
    process.env.GITHUB_SHA ||
    require('node:child_process')
      .execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
      .trim(),
  publishedAt: new Date().toISOString(),
  notes: fs
    .readFileSync(path.join(__dirname, '..', 'docs', 'RELEASE.md'), 'utf8')
    .split(/\r?\n/)
    .find((line) => line.trim() && !line.startsWith('#'))
    .trim(),
  assets,
};
fs.writeFileSync(output, JSON.stringify(release, null, 2) + '\n');
console.log(JSON.stringify(release));
