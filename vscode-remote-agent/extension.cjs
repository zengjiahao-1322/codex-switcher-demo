'use strict';
// 远端代理：装在 Remote-SSH 服务器一侧，只供本机伴随扩展经 VS Code 命令调用。
// 不联网、不主动做任何事；只读写服务器 CODEX_HOME 下三个固定文件（配置、模型目录、官方登录）。
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  childProcess = require('node:child_process');
const CONFIG = 'config.toml',
  CATALOG = 'switcher-model-catalog.json',
  AUTH = 'auth.json',
  BACKUP = '.switcher-backup';
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
// 协议号：同一版本号重新发布时，靠它认出缺少登录读写的旧代理（2 = 带 readAuth 和登录写入）。
const PROTOCOL = 2;

const claims = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
// 只取账号身份、邮箱、套餐和登录刷新时间，令牌本身不读出。
// id 与切换器保存账号的编号算法相同（账号 ID + 用户 ID），本机据此认出是哪个已保存账号。
function account(text) {
  const auth = JSON.parse(text);
  if (!auth.tokens?.access_token || !auth.tokens.account_id) return null;
  const access = claims(auth.tokens.access_token),
    id = auth.tokens.id_token ? claims(auth.tokens.id_token) : {},
    a = access['https://api.openai.com/auth'] || id['https://api.openai.com/auth'] || {};
  const userId = a.chatgpt_user_id || a.user_id || access.sub || id.sub || '';
  return {
    id: sha256(auth.tokens.account_id + '\0' + userId).slice(0, 20),
    email: id.email || access['https://api.openai.com/profile']?.email || '',
    plan: a.chatgpt_plan_type || 'unknown',
    lastRefresh: auth.last_refresh || null,
  };
}

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

function directChildren() {
  const command =
      process.platform === 'win32'
        ? [
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              `(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${process.pid}').ProcessId`,
            ],
          ]
        : ['ps', ['-eo', 'pid=,ppid=']],
    text = childProcess.execFileSync(command[0], command[1], {
      encoding: 'utf8',
      windowsHide: true,
    });
  if (process.platform === 'win32')
    return text
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, parent]) => Number.isInteger(pid) && parent === process.pid)
    .map(([pid]) => pid);
}

function stopDirectChildren() {
  for (const pid of directChildren()) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  process.kill(process.pid, 'SIGTERM');
}

function createAgent({ home, version }) {
  const startedAt = new Date().toISOString();
  const file = (name) => path.join(home, name);
  const content = (name) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : '');
  const snapshot = (name) => {
    const text = content(name);
    return { text, sha256: sha256(text) };
  };
  // 第一次改某个文件前留一份原始备份，以后不再覆盖。
  const backup = (name) => {
    if (fs.existsSync(file(name)) && !fs.existsSync(file(name + BACKUP)))
      writeAtomic(file(name + BACKUP), content(name));
  };
  return {
    status() {
      const exists = fs.existsSync(file(CONFIG));
      return {
        agentVersion: version,
        startedAt,
        protocol: PROTOCOL,
        host: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        codexHome: home,
        configExists: exists,
        current: exists ? summarize(content(CONFIG)) : null,
        account: fs.existsSync(file(AUTH)) ? account(content(AUTH)) : null,
      };
    },
    read: () => snapshot(CONFIG),
    readAuth: () => snapshot(AUTH),
    // text 为 null 时只写登录（同步较新的登录），auth 缺省时只写配置。
    write(input) {
      const keys = Object.keys(input || {});
      if (keys.some((key) => !['text', 'expectedSha256', 'catalog', 'auth'].includes(key)))
        throw Error('远端代理只接受 text、expectedSha256、catalog、auth。');
      const config = input.text !== null;
      if (config && (typeof input.text !== 'string' || typeof input.expectedSha256 !== 'string'))
        throw Error('缺少新配置或原配置校验值。');
      if (input.catalog != null && typeof input.catalog !== 'string')
        throw Error('模型目录必须是文本或 null。');
      const auth = input.auth ?? null;
      if (
        auth &&
        (Object.keys(auth).some((key) => !['text', 'expectedSha256'].includes(key)) ||
          typeof auth.text !== 'string' ||
          typeof auth.expectedSha256 !== 'string')
      )
        throw Error('登录只接受 text 和 expectedSha256。');
      if (!config && !auth) throw Error('没有要写入的配置或登录。');
      // 读取到写入之间文件被改过（用户手动、其他工具或 Codex 续期），不覆盖，交给下一次重新读取。
      // 两个文件都先核对再写，任何一个不符都不写。
      if (config && sha256(content(CONFIG)) !== input.expectedSha256)
        throw Error('服务器上的配置在读取后被修改过，未写入；请重新切换。');
      if (auth && sha256(content(AUTH)) !== auth.expectedSha256)
        throw Error('服务器上的登录在读取后被修改过，未写入；请重新切换。');
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      // 先写登录再写配置：配置改成官方登录时，登录文件已是目标账号。
      if (auth) {
        backup(AUTH);
        writeAtomic(file(AUTH), auth.text);
      }
      if (config) {
        backup(CONFIG);
        // 先写模型目录，配置引用它时文件已存在。
        if (input.catalog != null) writeAtomic(file(CATALOG), input.catalog);
        writeAtomic(file(CONFIG), input.text);
      }
      return {
        ok: true,
        sha256: config ? sha256(input.text) : null,
        authSha256: auth ? sha256(auth.text) : null,
      };
    },
    restart() {
      setTimeout(stopDirectChildren, 300).unref?.();
      return { restarting: true };
    },
  };
}

function activate(context) {
  const vscode = require('vscode');
  const agent = createAgent({
    home: path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')),
    version: require('./package.json').version,
  });
  for (const name of ['status', 'read', 'readAuth', 'write', 'restart'])
    context.subscriptions.push(
      vscode.commands.registerCommand('codexSwitcherRemote.' + name, (input) => agent[name](input)),
    );
}
module.exports = { activate, createAgent, summarize };
