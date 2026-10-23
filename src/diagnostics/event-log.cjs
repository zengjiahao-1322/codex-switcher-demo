'use strict';

const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const hidden = '[已隐藏]',
  secretField = /token|secret|password|api[-_]?key|authorization|cookie|credential/i,
  maxBytes = 2 * 1024 * 1024;

// 脱敏发生在落盘边界；返回副本，不改动业务对象或登录信息。
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secretField.test(key) ? hidden : redact(item),
      ]),
    );
  if (typeof value !== 'string') return value;
  let text = value
    .replace(/\beyJ[A-Za-z0-9_.-]+/g, hidden)
    .replace(/\bsk-[A-Za-z0-9_-]+/g, hidden)
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer ' + hidden)
    .replace(/([?&](?:code|state|[a-z_-]*token)=)[^&#\s"'<>]*/gi, '$1' + hidden)
    .replace(
      /\b([a-z0-9._%+-]{1,64})@([a-z0-9.-]+\.[a-z]{2,})\b/gi,
      (_, local, domain) => local.slice(0, 2) + '***@' + domain,
    );
  for (const home of new Set([os.homedir(), os.homedir().replace(/\\/g, '/')])) {
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped, process.platform === 'win32' ? 'gi' : 'g'), '~');
  }
  return text;
}

function log(bridgeHome, event, fields) {
  const dir = path.join(bridgeHome, 'logs'),
    file = path.join(dir, 'switcher.log');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 当前文件加两份旧文件；多进程使用同一追加日志，不另设锁或队列。
  if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
    fs.rmSync(file + '.2', { force: true });
    if (fs.existsSync(file + '.1')) fs.renameSync(file + '.1', file + '.2');
    fs.renameSync(file, file + '.1');
  }
  fs.appendFileSync(
    file,
    JSON.stringify(redact({ t: new Date().toISOString(), pid: process.pid, event, ...fields })) +
      '\n',
    { mode: 0o600 },
  );
}

function readRecent(bridgeHome, limit) {
  const file = path.join(bridgeHome, 'logs', 'switcher.log'),
    rows = [];
  for (const name of [file + '.2', file + '.1', file]) {
    if (!fs.existsSync(name)) continue;
    for (const line of fs.readFileSync(name, 'utf8').split('\n'))
      if (line) rows.push(JSON.parse(line));
  }
  return rows.sort((a, b) => a.t.localeCompare(b.t)).slice(-limit);
}

module.exports = { log, redact, readRecent };
