'use strict';
// 本工具自有的 API 配置库：所有配置都可编辑、删除。Hermes 中的供应商通过“导入”复制进来（保留原 id），
// 之后与自定义配置一样管理；本工具从不修改 Hermes 文件。
// 存储：<bridgeHome>/providers.json（含密钥，仅当前用户与 SYSTEM 可读）。密钥从不返回给浏览器。
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const MODES = ['responses', 'chat_completions', 'anthropic_messages'];
const file = (bridgeHome) => path.join(bridgeHome, 'providers.json');
// 旧格式 {custom,hiddenHermes} 兼容读取：custom 条目视为自定义。
function load(bridgeHome) {
  try {
    const s = JSON.parse(fs.readFileSync(file(bridgeHome), 'utf8'));
    return {
      providers: Array.isArray(s.providers)
        ? s.providers
        : Array.isArray(s.custom)
          ? s.custom.map((p) => ({ origin: 'custom', ...p }))
          : [],
      hermesImported: !!s.hermesImported,
      skippedHermes: Array.isArray(s.hiddenHermes)
        ? s.hiddenHermes
        : Array.isArray(s.skippedHermes)
          ? s.skippedHermes
          : [],
    };
  } catch (e) {
    if (e.code === 'ENOENT') return { providers: [], hermesImported: false, skippedHermes: [] };
    throw Error('providers.json 已损坏，请检查或删除后重试');
  }
}
function save(bridgeHome, state, acl) {
  fs.mkdirSync(bridgeHome, { recursive: true });
  const target = file(bridgeHome),
    temp = target + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
  try {
    acl?.(temp);
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
function clean(input, existing, { allowEmptyKey = false } = {}) {
  const name = String(input.name ?? existing?.name ?? '').trim();
  if (!name || name.length > 60) throw Error('名称必填，最多 60 个字符');
  const baseUrl = String(input.baseUrl ?? existing?.baseUrl ?? '')
    .trim()
    .replace(/\/+$/, '');
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw Error('API 地址无效');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error('API 地址须为 http(s)，且不含用户名、密码、查询参数');
  const apiMode = String(input.apiMode ?? existing?.apiMode ?? '');
  if (!MODES.includes(apiMode)) throw Error('协议类型无效');
  const models = [
    ...new Set(
      (Array.isArray(input.models)
        ? input.models
        : String(input.models ?? existing?.models?.join(',') ?? '').split(/[,，\s]+/)
      )
        .map((x) => String(x).trim())
        .filter(Boolean),
    ),
  ];
  const model = String(input.model ?? existing?.model ?? models[0] ?? '').trim();
  if (!model || model.length > 200) throw Error('默认模型必填');
  if (!models.includes(model)) models.unshift(model);
  if (models.length > 100) throw Error('模型最多 100 个');
  const key =
    input.apiKey === undefined || input.apiKey === ''
      ? (existing?.apiKey ?? '')
      : String(input.apiKey).trim();
  if ((!key && !allowEmptyKey) || key.length > 4096 || /\s/.test(key))
    throw Error('API 密钥必填，且不能含空白字符');
  return { name, baseUrl, apiMode, model, models, apiKey: key };
}
function list(bridgeHome) {
  return load(bridgeHome).providers.map((p) => ({
    ...p,
    source: p.origin === 'hermes' ? 'hermes' : 'custom',
  }));
}
function uniqueName(s, name, exceptId) {
  if (s.providers.some((x) => x.id !== exceptId && x.name === name)) throw Error('已有同名配置');
}
function add(bridgeHome, input, acl) {
  const s = load(bridgeHome);
  const p = {
    id: 'bridge:' + crypto.randomUUID(),
    origin: 'custom',
    ...clean(input),
    createdAt: new Date().toISOString(),
  };
  uniqueName(s, p.name);
  s.providers.push(p);
  save(bridgeHome, s, acl);
  return p.id;
}
function update(bridgeHome, id, input, acl) {
  const s = load(bridgeHome);
  const i = s.providers.findIndex((x) => x.id === id);
  if (i < 0) throw Error('配置不存在，请刷新页面');
  const next = {
    ...s.providers[i],
    ...clean(input, s.providers[i], { allowEmptyKey: !s.providers[i].apiKey }),
    updatedAt: new Date().toISOString(),
  };
  uniqueName(s, next.name, id);
  s.providers[i] = next;
  save(bridgeHome, s, acl);
}
// 删除导入的 Hermes 配置时记下 id，自动导入不会让它“复活”；手动“从 Hermes 导入”可以找回。
function remove(bridgeHome, id, acl) {
  const s = load(bridgeHome);
  const p = s.providers.find((x) => x.id === id);
  if (!p) throw Error('配置不存在，请刷新页面');
  s.providers = s.providers.filter((x) => x.id !== id);
  if (p.origin === 'hermes' && !s.skippedHermes.includes(id)) s.skippedHermes.push(id);
  save(bridgeHome, s, acl);
}
// 从 Hermes 导入尚未存在的供应商（按 id）。auto=true 时（首次启动）跳过用户删除过的；手动导入时一并找回。同名时自动加后缀。
function importHermes(bridgeHome, hermesProviders, acl, { auto = false } = {}) {
  const s = load(bridgeHome);
  if (auto && s.hermesImported) return { added: [], failed: 0 };
  const have = new Set(s.providers.map((p) => p.id)),
    skipped = new Set(auto ? s.skippedHermes : []);
  const added = [];
  let failed = 0;
  for (const h of hermesProviders) {
    if (have.has(h.id) || skipped.has(h.id)) continue;
    let c;
    try {
      c = clean(h, null, { allowEmptyKey: true });
    } catch {
      failed++;
      continue;
    }
    let name = c.name,
      n = 2;
    while (s.providers.some((x) => x.name === name)) name = c.name + ' (' + n++ + ')';
    s.providers.push({
      id: h.id,
      origin: 'hermes',
      ...c,
      name,
      createdAt: new Date().toISOString(),
    });
    added.push(name);
  }
  s.skippedHermes = s.skippedHermes.filter((id) => !s.providers.some((p) => p.id === id));
  s.hermesImported = true;
  save(bridgeHome, s, acl);
  return { added, failed };
}
function hermesImported(bridgeHome) {
  return load(bridgeHome).hermesImported;
}
// 检测结果（接入方式）：按配置保存最近一次结果；地址/协议/密钥变化后签名不符，视为未检测。
const probesFile = (bridgeHome) => path.join(bridgeHome, 'probe-results.json');
const signature = (p) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify([p.baseUrl, p.apiMode, p.apiKey]))
    .digest('hex')
    .slice(0, 16);
function loadProbes(bridgeHome) {
  try {
    return JSON.parse(fs.readFileSync(probesFile(bridgeHome), 'utf8')) || {};
  } catch {
    return {};
  }
}
function recordProbe(bridgeHome, p, model, mode, message) {
  const all = loadProbes(bridgeHome);
  all[p.id] = {
    model,
    mode,
    message: String(message || '').slice(0, 300),
    at: new Date().toISOString(),
    sig: signature(p),
  };
  fs.mkdirSync(bridgeHome, { recursive: true });
  fs.writeFileSync(probesFile(bridgeHome), JSON.stringify(all, null, 2), { mode: 0o600 });
}
function access(bridgeHome, p) {
  const r = loadProbes(bridgeHome)[p.id];
  if (!r || r.sig !== signature(p)) return { mode: 'unknown' };
  return { mode: r.mode, model: r.model, at: r.at, message: r.message };
}
// 地址指向本机的配置（本机代理程序），与本工具自己的“本机转换服务”区分显示。
function isLocal(p) {
  try {
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(p.baseUrl).hostname);
  } catch {
    return false;
  }
}
module.exports = {
  list,
  add,
  update,
  remove,
  importHermes,
  hermesImported,
  MODES,
  recordProbe,
  access,
  isLocal,
};
