'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { PROJECT_ROOT } = require('../paths.cjs');
let cached;
// 源码保留 null；构建脚本把同一个工作流序号写入所有平台的包。
function releaseInfo(sequence) {
  return JSON.stringify({ sequence }, null, 2) + '\n';
}
function buildInfo(sequence = require('./release-info.json').sequence) {
  if (cached?.sequence === sequence) return cached;
  const hash = crypto.createHash('sha256');
  // 只计算实际发行的代码；统一换行，源码、Windows/Mac 包和发布元数据得到同一构建号。
  const files = require('../../release-files.json').filter(
    (file) =>
      file === 'release-files.json' ||
      /^(?:src|web|platform|vscode-companion|vscode-remote-agent)\//.test(file) ||
      ['scripts/update-worker.cjs', 'main.cjs', 'package.json'].includes(file),
  );
  for (const relative of files.sort()) {
    hash.update(relative + '\0');
    hash.update(
      relative === 'src/platform/release-info.json'
        ? releaseInfo(sequence)
        : fs.readFileSync(path.join(PROJECT_ROOT, relative), 'utf8').replace(/\r\n/g, '\n'),
    );
  }
  cached = {
    version: require('../../package.json').version,
    id: hash.digest('hex').slice(0, 12),
    sequence,
  };
  return cached;
}
module.exports = { buildInfo, releaseInfo };
