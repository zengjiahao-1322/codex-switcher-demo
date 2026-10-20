'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  cp = require('node:child_process');
const mac = process.platform === 'darwin';
const dataHome = () =>
  process.env.BRIDGE_HOME ||
  (mac
    ? path.join(os.homedir(), 'Library', 'Application Support', 'CodexApiSwitcher')
    : path.join(__dirname, 'private'));
function settings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataHome(), 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}
const codexHome = () =>
  process.env.BRIDGE_CODEX_HOME ||
  settings().codexHome ||
  process.env.CODEX_HOME ||
  path.join(os.homedir(), '.codex');
const nodePath = (dir = __dirname) => {
  const file = mac
    ? path.join(dir, 'runtime', process.arch, 'node')
    : path.join(dir, 'runtime', 'node.exe');
  return fs.existsSync(file) ? file : process.execPath;
};
const openUrl = (url) =>
  cp
    .spawn(mac ? 'open' : 'explorer.exe', [url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    .unref();
function launch(open = false) {
  cp.spawn(nodePath(), [path.join(__dirname, 'main.cjs'), ...(open ? [] : ['--no-open'])], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}
function macApps() {
  return [
    process.env.CODEX_DESKTOP_APP,
    ...['/Applications', path.join(os.homedir(), 'Applications')].map((dir) =>
      path.join(dir, 'Codex.app'),
    ),
  ].filter(Boolean);
}
function isCodexDesktop(exe = '') {
  if (/OpenAI[.\\/]Codex[^\\/\n]*[\\/]app[\\/](?:ChatGPT|Codex)\.exe$/i.test(exe)) return true;
  const app = exe.match(/^(.+\.app)\/Contents\/MacOS\/(?:Codex|ChatGPT)$/)?.[1];
  // ChatGPT.app 是另一个产品；只有 Codex 应用或用户明确指定的应用才参与切换。
  return (
    !!app &&
    (app.endsWith('/Codex.app') ||
      (!!process.env.CODEX_DESKTOP_APP &&
        path.resolve(app) === path.resolve(process.env.CODEX_DESKTOP_APP)))
  );
}
let proxyCache;
function codexEnv(home) {
  // Finder 启动的应用通常没有终端 PATH 和代理变量。补入随包 Node 路径，
  // 并在没有显式代理时采用 macOS 系统的手动 HTTP / SOCKS 代理。
  const env = {
    ...process.env,
    CODEX_HOME: home,
    PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || ''),
  };
  if (mac && !env.HTTPS_PROXY && !env.https_proxy && !env.ALL_PROXY && !env.all_proxy) {
    if (!proxyCache || Date.now() - proxyCache.at > 60000) {
      let values = {};
      try {
        const text = cp.execFileSync('/usr/sbin/scutil', ['--proxy'], {
          encoding: 'utf8',
          timeout: 2000,
        });
        values = Object.fromEntries(
          [
            ...text.matchAll(
              /^\s*(HTTPSEnable|HTTPSProxy|HTTPSPort|HTTPEnable|HTTPProxy|HTTPPort|SOCKSEnable|SOCKSProxy|SOCKSPort)\s*:\s*(.+)$/gm,
            ),
          ].map((m) => [m[1], m[2].trim()]),
        );
      } catch {}
      proxyCache = { at: Date.now(), values };
    }
    const v = proxyCache.values;
    if (v.HTTPSEnable === '1' && v.HTTPSProxy)
      env.HTTPS_PROXY = 'http://' + v.HTTPSProxy + ':' + v.HTTPSPort;
    if (v.HTTPEnable === '1' && v.HTTPProxy && !env.HTTP_PROXY && !env.http_proxy)
      env.HTTP_PROXY = 'http://' + v.HTTPProxy + ':' + v.HTTPPort;
    if (v.SOCKSEnable === '1' && v.SOCKSProxy && !env.HTTPS_PROXY)
      env.ALL_PROXY = 'socks5h://' + v.SOCKSProxy + ':' + v.SOCKSPort;
  }
  return env;
}
module.exports = {
  mac,
  dataHome,
  codexHome,
  nodePath,
  openUrl,
  launch,
  macApps,
  isCodexDesktop,
  codexEnv,
};
