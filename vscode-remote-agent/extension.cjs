'use strict';
// 远端代理：装在 Remote-SSH 服务器一侧，只供本机伴随扩展经 VS Code 命令调用。
// 不联网、不主动做任何事；只读写服务器 CODEX_HOME 下两个固定文件。
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const CONFIG = 'config.toml',
  CATALOG = 'switcher-model-catalog.json',
  BACKUP = 'config.toml.switcher-backup';
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// 只取状态展示需要的模型、provider 和 base_url；密钥等其他键不读出。
function summarize(text) {
  const top = {},
    sections = {};
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(),
      header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      section = header[1].replace(/\s/g, '').replace(/"/g, '');
      continue;
    }
    const pair = /^["']?([\w-]+)["']?\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(line);
    if (!pair || !['model', 'model_provider', 'base_url'].includes(pair[1])) continue;
    (section === null ? top : (sections[section] ||= {}))[pair[1]] = pair[2] ?? pair[3];
  }
  const provider = top.model_provider || null;
  return {
    model: top.model || null,
    modelProvider: provider,
    baseUrl: (provider && sections['model_providers.' + provider]?.base_url) || null,
  };
}

// 临时文件加改名，任何时刻文件要么是旧内容要么是新内容；权限只给当前用户。
function writeAtomic(file, text) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
}

function createAgent({ home, version }) {
  const config = path.join(home, CONFIG);
  const current = () => (fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '');
  return {
    status() {
      const exists = fs.existsSync(config);
      return {
        agentVersion: version,
        host: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        codexHome: home,
        configExists: exists,
        current: exists ? summarize(current()) : null,
      };
    },
    read() {
      const text = current();
      return { text, sha256: sha256(text) };
    },
    write(input) {
      const keys = Object.keys(input || {});
      if (keys.some((key) => !['text', 'expectedSha256', 'catalog'].includes(key)))
        throw Error('远端代理只接受 text、expectedSha256、catalog。');
      if (typeof input.text !== 'string' || typeof input.expectedSha256 !== 'string')
        throw Error('缺少新配置或原配置校验值。');
      if (input.catalog !== null && typeof input.catalog !== 'string')
        throw Error('模型目录必须是文本或 null。');
      // 读取到写入之间配置被改过（用户手动或其他工具），不覆盖，交给下一次切换重新读取。
      if (sha256(current()) !== input.expectedSha256)
        throw Error('服务器上的配置在读取后被修改过，未写入；请重新切换。');
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      const backup = path.join(home, BACKUP);
      if (fs.existsSync(config) && !fs.existsSync(backup)) writeAtomic(backup, current());
      // 先写模型目录，配置引用它时文件已存在。
      if (input.catalog !== null) writeAtomic(path.join(home, CATALOG), input.catalog);
      writeAtomic(config, input.text);
      return { ok: true, sha256: sha256(input.text) };
    },
  };
}

function activate(context) {
  const vscode = require('vscode');
  const agent = createAgent({
    home: path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')),
    version: require('./package.json').version,
  });
  for (const name of ['status', 'read', 'write'])
    context.subscriptions.push(
      vscode.commands.registerCommand('codexSwitcherRemote.' + name, (input) => agent[name](input)),
    );
}
module.exports = { activate, createAgent, summarize };
