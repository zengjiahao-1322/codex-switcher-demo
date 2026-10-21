'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { PROJECT_ROOT } = require('../paths.cjs');
let cached;
function buildInfo() {
  if (cached) return cached;
  const hash = crypto.createHash('sha256');
  const visit = (relative) => {
    const file = path.join(PROJECT_ROOT, relative);
    if (fs.statSync(file).isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
    } else {
      hash.update(relative.replace(/\\/g, '/') + '\0');
      hash.update(fs.readFileSync(file));
    }
  };
  // 运行代码与页面决定构建标识；文档和用户数据不参与，不随页面轮询重新计算。
  for (const item of ['src', 'web', 'platform', 'vscode-companion', 'main.cjs', 'package.json'])
    visit(item);
  cached = { version: require('../../package.json').version, id: hash.digest('hex').slice(0, 12) };
  return cached;
}
module.exports = { buildInfo };
