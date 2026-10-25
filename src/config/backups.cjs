'use strict';

const fs = require('node:fs'),
  path = require('node:path'),
  toml = require('smol-toml');
const { log } = require('../diagnostics/event-log.cjs');
const directory = (home) => path.join(home, 'backups', 'codex-config'),
  pattern = /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)-(switch|official|restore)\.toml$/,
  time = (stamp) => stamp.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
function files(home) {
  const dir = directory(home);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => pattern.test(name))
    .sort()
    .reverse();
}
function summary(config) {
  const provider = config.model_provider || 'openai',
    name = provider === 'openai' ? '官方' : config.model_providers?.[provider]?.name || provider;
  return name + ' · ' + (config.model || '默认模型');
}
function list(home) {
  return files(home).map((id) => {
    const [, stamp, reason] = pattern.exec(id);
    return {
      id,
      at: time(stamp),
      reason,
      summary: summary(toml.parse(fs.readFileSync(path.join(directory(home), id), 'utf8'))),
    };
  });
}
function read(home, id) {
  // HTTP 的 id 只能对应已列出的备份，不能被当作任意文件路径。
  if (!files(home).includes(id)) throw Error('配置备份不存在，请刷新列表。');
  const text = fs.readFileSync(path.join(directory(home), id), 'utf8');
  return { text, config: toml.parse(text) };
}
function save(codexHome, home, reason) {
  const file = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8'),
    previous = files(home),
    dir = directory(home);
  if (previous.length && fs.readFileSync(path.join(dir, previous[0]), 'utf8') === text) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 连续写入同一毫秒时也按保存顺序排列，不另存索引或指纹。
  const last = previous.length ? Date.parse(time(pattern.exec(previous[0])[1])) : 0,
    stamp = new Date(Math.max(Date.now(), last + 1)).toISOString().replace(/[:.]/g, '-'),
    id = stamp + '-' + reason + '.toml';
  fs.writeFileSync(path.join(dir, id), text, { flag: 'wx', mode: 0o600 });
  for (const old of previous.slice(9)) fs.unlinkSync(path.join(dir, old));
  log(home, 'config.backup', { reason, kept: Math.min(10, previous.length + 1) });
}

module.exports = { save, list, read, summary };
