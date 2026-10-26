'use strict';
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');
const toml = require('smol-toml');
function discoverProviders(home) {
  const source = fs.readFileSync(path.join(home, 'config.yaml'), 'utf8');
  let config;
  try {
    config = yaml.parse(source) || {};
  } catch {
    throw new Error('Invalid Hermes YAML configuration (details redacted)');
  }
  const env = {};
  let text = '';
  try {
    text = fs.readFileSync(path.join(home, '.env'), 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([\w]+)\s*=\s*(.*?)\s*$/);
    if (m) {
      let v = m[2];
      if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))
        v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, '');
      env[m[1]] = v;
    }
  }
  const resolve = (v) => String(v || '').replace(/\$\{(\w+)\}/g, (_, k) => env[k] || '');
  const current = config.model || {};
  const entries = { ...(config.providers || {}) };
  if (current.provider && !entries[current.provider] && current.base_url)
    entries[current.provider] = current;
  return Object.entries(entries).map(([id, p]) => {
    const active = current.provider === id;
    const model = (active && current.default) || p.model || p.default || '';
    return {
      id,
      name: p.name || id,
      active,
      baseUrl: resolve(p.base_url || (active && current.base_url)),
      model,
      models: [
        ...new Set(
          [...(Array.isArray(p.models) ? p.models : Object.keys(p.models || {})), model].filter(
            Boolean,
          ),
        ),
      ],
      apiMode: p.api_mode || (active && current.api_mode) || 'responses',
      apiKey: resolve(p.api_key || (active && current.api_key)),
    };
  });
}
function publicProviders(providers) {
  return providers.map(({ apiKey, ...p }) => p);
}
// Tokenize complete TOML statements, never treating text inside strings as headers.
function statements(text) {
  const out = [];
  let start = 0,
    quote = '',
    multi = false,
    depth = 0,
    comment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (comment) {
      if (c !== '\n') continue;
      comment = false;
    } else if (quote) {
      if (quote === '"' && c === '\\') {
        i++;
        continue;
      }
      if (multi) {
        if (text.slice(i, i + 3) === quote.repeat(3)) {
          quote = '';
          multi = false;
          i += 2;
        }
      } else if (c === quote) quote = '';
      continue;
    } else if (c === '"' || c === "'") {
      quote = c;
      multi = text.slice(i, i + 3) === c.repeat(3);
      if (multi) i += 2;
      continue;
    } else if (c === '#') {
      comment = true;
      continue;
    } else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    if (c === '\n' && !depth && !quote) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}
function headerPath(statement) {
  if (!statement.trimStart().startsWith('[')) return null;
  const obj = toml.parse(statement);
  const keys = [];
  let o = obj;
  while (o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === 1) {
    const k = Object.keys(o)[0];
    keys.push(k);
    o = o[k];
  }
  return keys;
}
function editSelection(text, selection, bridge) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  let section = [];
  let body = '';
  for (const s of statements(text)) {
    const h = headerPath(s);
    if (h) section = h;
    if (section[0] === 'model_providers' && section[1] === 'hermes_bridge') continue;
    // 本工具管理的顶层键：model、model_provider、model_catalog_json（Codex 模型下拉列表来源）。
    if (
      !section.length &&
      /^\s*(?:model|model_provider|model_catalog_json|"model"|"model_provider"|"model_catalog_json"|'model'|'model_provider'|'model_catalog_json')\s*=/.test(
        s,
      )
    )
      continue;
    if (
      !section.length &&
      selection.cli_auth_credentials_store !== undefined &&
      /^\s*(?:cli_auth_credentials_store|"cli_auth_credentials_store"|'cli_auth_credentials_store')\s*=/.test(
        s,
      )
    )
      continue;
    body += s;
  }
  let prefix = '';
  for (const key of ['model', 'model_provider', 'model_catalog_json', 'cli_auth_credentials_store'])
    if (selection[key] !== undefined)
      prefix += toml.stringify({ [key]: selection[key] }).trimEnd() + nl;
  let result = prefix + body;
  if (bridge) {
    if (result && !result.endsWith('\n')) result += nl;
    result += toml.stringify({ model_providers: { hermes_bridge: bridge } }).replace(/\r?\n/g, nl);
  }
  toml.parse(result);
  return result;
}
function parseToml(text) {
  try {
    return toml.parse(text);
  } catch {
    throw new Error('Invalid TOML configuration (details redacted)');
  }
}
// catalogPath：可选的模型目录 JSON 路径，写入 model_catalog_json，使 Codex 模型下拉只显示该配置的模型。
function prepareConfig(originalToml, provider, model, catalogPath) {
  parseToml(originalToml);
  if (
    !provider ||
    typeof model !== 'string' ||
    !model.trim() ||
    typeof provider.apiKey !== 'string' ||
    !provider.apiKey.trim()
  )
    throw new Error('Provider key and model are required');
  let url;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    throw new Error('Invalid provider URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Provider URL must be HTTP(S) without userinfo');
  return editSelection(
    originalToml,
    { model, model_provider: 'hermes_bridge', model_catalog_json: catalogPath || undefined },
    {
      name: provider.name || provider.id,
      base_url: provider.baseUrl,
      wire_api: 'responses',
      experimental_bearer_token: provider.apiKey,
      requires_openai_auth: false,
    },
  );
}
const crypto = require('node:crypto');
const cp = require('node:child_process');
function privateAcl(target) {
  if (process.platform !== 'win32') {
    fs.chmodSync(target, fs.statSync(target).isDirectory() ? 0o700 : 0o600);
    return;
  }
  const script =
    "$ErrorActionPreference='Stop'; $p=$env:BRIDGE_ACL_TARGET; $id=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $sys=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18'); $dir=(Get-Item -LiteralPath $p).PSIsContainer; if($dir){$acl=New-Object System.Security.AccessControl.DirectorySecurity; $flags=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{$acl=New-Object System.Security.AccessControl.FileSecurity; $flags=[System.Security.AccessControl.InheritanceFlags]::None}; $acl=Get-Acl -LiteralPath $p; $acl.SetAccessRuleProtection($true,$false); foreach($r in @($acl.Access)){$acl.RemoveAccessRuleSpecific($r)}; $acl.SetOwner($id); foreach($sid in @($id,$sys)){$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$flags,'None','Allow'); $acl.AddAccessRule($rule)}; if($dir){[System.IO.Directory]::SetAccessControl($p,$acl)}else{[System.IO.File]::SetAccessControl($p,$acl)}";
  const env = { ...process.env, BRIDGE_ACL_TARGET: target };
  delete env.PSModulePath;
  try {
    cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env,
      stdio: 'pipe',
      windowsHide: true,
    });
  } catch {
    throw new Error('Could not restrict file permissions');
  }
}
function readOptional(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
function atomicWrite(file, text, expected) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, '', { flag: 'wx', mode: 0o600 });
    privateAcl(temp);
    const fd = fs.openSync(temp, 'w');
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (expected !== undefined && readOptional(file) !== expected)
      throw new Error('Concurrent config modification detected; retry after review');
    fs.renameSync(temp, file);
    if (readOptional(file) !== text)
      throw new Error('Concurrent config modification after replacement');
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function applySwitch(codexHome, provider, model, bridgeHome, catalogPath) {
  const configPath = path.join(codexHome, 'config.toml');
  const original = readOptional(configPath);
  const next = prepareConfig(original || '', provider, model, catalogPath);
  fs.mkdirSync(bridgeHome, { recursive: true });
  privateAcl(bridgeHome);
  // 快照记录“切换前的官方状态”：当前不是桥接时每次都刷新（保留用户恢复后对官方设置的改动）；桥接→桥接时保留原快照。
  const backupPath = path.join(bridgeHome, 'original-config.toml');
  if (!fs.existsSync(backupPath) || parseToml(original || '').model_provider !== 'hermes_bridge')
    atomicWrite(backupPath, original || '');
  require('./backups.cjs').save(codexHome, bridgeHome, 'switch');
  atomicWrite(configPath, next, original);
  return { ok: true, model, modelProvider: 'hermes_bridge', configPath, backupPath };
}
// 切换到 Codex 官方登录（内置 openai provider，使用 auth.json 中的登录），可指定官方模型；保留 hermes_bridge 定义以便旧对话继续。
// catalog：切回官方后 model_catalog_json 的值（用户原有设置；通常为空，即使用官方模型列表）。
function prepareOfficialConfig(current, model, catalog, credentialsStore) {
  // 新安装的插件可能尚无模型缓存；移除自定义模型后，由官方客户端选择默认模型。
  if (
    model !== undefined &&
    (typeof model !== 'string' || model.length > 200 || /[\r\n"]/.test(model))
  )
    throw new Error('官方模型名称无效');
  const parsed = parseToml(current || '');
  return editSelection(
    current || '',
    {
      model: model?.trim() || undefined,
      model_catalog_json: catalog || undefined,
      cli_auth_credentials_store: credentialsStore,
    },
    parsed.model_providers?.hermes_bridge,
  );
}
function applyOfficial(codexHome, model, catalog, credentialsStore, bridgeHome) {
  const configPath = path.join(codexHome, 'config.toml');
  const current = readOptional(configPath);
  const next = prepareOfficialConfig(current, model, catalog, credentialsStore);
  fs.mkdirSync(codexHome, { recursive: true });
  require('./backups.cjs').save(codexHome, bridgeHome, 'official');
  atomicWrite(configPath, next, current === null ? undefined : current);
  return { ok: true, model: model?.trim() || null, modelProvider: 'openai', configPath };
}
// 卸载清理：Codex 未在使用本工具的配置时，移除 [model_providers.hermes_bridge]（含密钥）以及指向本工具模型目录的 model_catalog_json。
function cleanupBridge(codexHome, catalogPath) {
  const configPath = path.join(codexHome, 'config.toml');
  const current = readOptional(configPath);
  if (current === null) return { changed: false };
  const parsed = parseToml(current);
  if (parsed.model_provider === 'hermes_bridge')
    throw new Error('Codex 仍在使用本工具的配置，请先切回官方登录');
  const ownCatalog =
    catalogPath &&
    parsed.model_catalog_json &&
    path.resolve(parsed.model_catalog_json) === path.resolve(catalogPath);
  if (!parsed.model_providers?.hermes_bridge && !ownCatalog) return { changed: false };
  const next = editSelection(
    current,
    {
      model: parsed.model,
      model_provider: parsed.model_provider,
      model_catalog_json: ownCatalog ? undefined : parsed.model_catalog_json,
    },
    undefined,
  );
  atomicWrite(configPath, next, current);
  return { changed: true };
}
function restoreOfficial(codexHome, bridgeHome) {
  const configPath = path.join(codexHome, 'config.toml');
  const backupPath = path.join(bridgeHome, 'original-config.toml');
  const current = readOptional(configPath);
  const parsed = parseToml(current || '');
  // 当前未桥接：已是官方/用户自己的设置，不做任何改动。
  if (parsed.model_provider !== 'hermes_bridge')
    return {
      ok: true,
      alreadyOfficial: true,
      model: parsed.model,
      modelProvider: parsed.model_provider || 'openai',
      configPath,
      backupPath,
    };
  const backup = readOptional(backupPath);
  if (backup === null)
    throw new Error('没有找到切换前的配置快照，无法自动恢复；请在 Codex 设置中手动选择模型');
  const original = parseToml(backup);
  // 保留当前 hermes_bridge 定义：切换期间新建的线程记录了该 provider，删除后这些线程将无法继续。新对话仍回到原 provider。
  const next = editSelection(
    current || '',
    {
      model: original.model,
      model_provider: original.model_provider,
      model_catalog_json: original.model_catalog_json,
    },
    parsed.model_providers?.hermes_bridge || original.model_providers?.hermes_bridge,
  );
  require('./backups.cjs').save(codexHome, bridgeHome, 'official');
  atomicWrite(configPath, next, current);
  return {
    ok: true,
    model: original.model,
    modelProvider: original.model_provider || 'openai',
    configPath,
    backupPath,
  };
}
function withLock(home, fn) {
  const file = path.join(home, '.hermes-bridge.lock');
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (e) {
    if (e.code === 'EEXIST')
      throw new Error('Bridge config is locked; review stale lock before retrying');
    throw e;
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(file);
  }
}
function restoreBackup(codexHome, bridgeHome, id, catalog) {
  const backups = require('./backups.cjs'),
    { text, config } = backups.read(bridgeHome, id),
    configPath = path.join(codexHome, 'config.toml'),
    current = readOptional(configPath);
  backups.save(codexHome, bridgeHome, 'restore');
  const next =
    catalog === undefined
      ? text
      : editSelection(
          text,
          {
            model: config.model,
            model_provider: config.model_provider,
            model_catalog_json: catalog || undefined,
          },
          config.model_providers?.hermes_bridge,
        );
  atomicWrite(configPath, next, current);
  return { model: config.model || null, modelProvider: config.model_provider || 'openai' };
}
module.exports = {
  discoverProviders,
  publicProviders,
  prepareConfig,
  prepareOfficialConfig,
  privateAcl,
  applySwitch: (home, p, m, b, cat) => withLock(home, () => applySwitch(home, p, m, b, cat)),
  restoreOfficial: (home, b) => withLock(home, () => restoreOfficial(home, b)),
  applyOfficial: (home, m, cat, credentialsStore, bridgeHome) =>
    withLock(home, () => applyOfficial(home, m, cat, credentialsStore, bridgeHome)),
  restoreBackup: (home, bridgeHome, id, catalog) =>
    withLock(home, () => restoreBackup(home, bridgeHome, id, catalog)),
  cleanupBridge: (home, cat) => withLock(home, () => cleanupBridge(home, cat)),
};
