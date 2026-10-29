'use strict';
const { PROJECT_ROOT } = require('../paths.cjs');

const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  cp = require('node:child_process');
const mac = process.platform === 'darwin';
const dataHome = () =>
  (process.env.BRIDGE_HOME && !require('./data-migration.cjs').usesDefault(PROJECT_ROOT)
    ? process.env.BRIDGE_HOME
    : null) ||
  (mac
    ? path.join(os.homedir(), 'Library', 'Application Support', 'CodexApiSwitcher')
    : process.platform === 'win32'
      ? path.join(
          process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'),
          'CodexSwitcher',
        )
      : path.join(PROJECT_ROOT, 'private'));
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
const nodePath = (dir = PROJECT_ROOT) => {
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
  cp.spawn(nodePath(), [path.join(PROJECT_ROOT, 'main.cjs'), ...(open ? [] : ['--no-open'])], {
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
const proxyKeys = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
];
function windowsProxyEnv(settings) {
  if (settings.enabled !== 1 || !settings.server) return {};
  const entries = Object.fromEntries(
    settings.server.split(';').map((entry) => {
      const at = entry.indexOf('=');
      return at < 0
        ? ['all', entry.trim()]
        : [entry.slice(0, at).trim(), entry.slice(at + 1).trim()];
    }),
  );
  const proxy = (value) => (value.includes('://') ? value : 'http://' + value);
  const env = {};
  if (entries.http || entries.all) env.HTTP_PROXY = proxy(entries.http || entries.all);
  if (entries.https || entries.all) env.HTTPS_PROXY = proxy(entries.https || entries.all);
  if (entries.socks) env.ALL_PROXY = 'socks5h://' + entries.socks;
  return env;
}
function codexEnv(home) {
  // Finder 启动的应用通常没有终端 PATH 和代理变量。补入随包 Node 路径，
  // 并在没有显式代理时采用 macOS 系统的手动 HTTP / SOCKS 代理。
  const env = {
    ...process.env,
    CODEX_HOME: home,
    PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || ''),
  };
  const hasExplicitProxy = proxyKeys.some((key) => env[key]);
  if (process.platform === 'win32' && !hasExplicitProxy) {
    // Windows 桌面启动通常没有代理环境变量，但系统代理可能已经开启。
    if (!proxyCache || Date.now() - proxyCache.at > 60000) {
      let values = {};
      try {
        values = JSON.parse(
          cp.execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              "$settings = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; $connection = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections' -ErrorAction SilentlyContinue; $flags = $connection.DefaultConnectionSettings; [pscustomobject]@{enabled=[int]$settings.ProxyEnable;server=[string]$settings.ProxyServer;autoDetect=[bool]($settings.AutoDetect -or ($flags.Length -gt 8 -and ($flags[8] -band 8)));autoConfigUrl=[string]$settings.AutoConfigURL} | ConvertTo-Json -Compress",
            ],
            { encoding: 'utf8', timeout: 3000, windowsHide: true },
          ),
        );
      } catch {}
      proxyCache = { at: Date.now(), values };
    }
    Object.assign(env, windowsProxyEnv(proxyCache.values));
    if ((env.HTTP_PROXY || env.HTTPS_PROXY || env.ALL_PROXY) && !env.NO_PROXY && !env.no_proxy)
      env.NO_PROXY = 'localhost,127.0.0.1,::1';
  }
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
              /^\s*(HTTPSEnable|HTTPSProxy|HTTPSPort|HTTPEnable|HTTPProxy|HTTPPort|SOCKSEnable|SOCKSProxy|SOCKSPort|ProxyAutoConfigEnable|ProxyAutoDiscoveryEnable)\s*:\s*(.+)$/gm,
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
function proxyEndpoint(value) {
  const text = value.includes('://') ? value : 'http://' + value;
  try {
    const url = new URL(text);
    return url.protocol + '//' + url.host;
  } catch {
    return null;
  }
}
function proxyInfo(home) {
  const env = codexEnv(home),
    // 更新地址固定为 HTTPS；curl 按 HTTPS_PROXY / ALL_PROXY 选择代理。
    value = env.https_proxy || env.HTTPS_PROXY || env.all_proxy || env.ALL_PROXY;
  if (value) return { type: 'manual', value: proxyEndpoint(value) || 'unknown' };
  if (process.platform === 'win32') {
    const values = proxyCache?.values || {};
    if (values.autoDetect || values.autoConfigUrl) return { type: 'auto' };
  }
  if (mac) {
    const values = proxyCache?.values || {};
    if (values.ProxyAutoConfigEnable === '1' || values.ProxyAutoDiscoveryEnable === '1')
      return { type: 'auto' };
  }
  return { type: 'none' };
}
function proxySource(home) {
  if (proxyKeys.some((key) => process.env[key])) return 'env';
  const env = codexEnv(home);
  return proxyKeys.some((key) => env[key]) ? 'system' : 'none';
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
  proxyInfo,
  proxySource,
  windowsProxyEnv,
};
