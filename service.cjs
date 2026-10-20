'use strict';
// 切换器核心服务：网页（main.cjs，HTTP）与 Codex 内的 MCP 工具（mcp-server.cjs，stdio）共用。
// 配置库独立（providers.json）；Hermes 只在首次启动时作为导入来源。“官方登录”是固定的第一项，不可删除。
const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process'),
  crypto = require('node:crypto'),
  toml = require('smol-toml');
const core = require('./core.cjs'),
  { probe, probeNative, listModels } = require('./probe.cjs'),
  { findCodex } = require('./runtime.cjs'),
  autostart = require('./autostart.cjs'),
  store = require('./providers.cjs');
const { createAccounts } = require('./accounts.cjs'),
  { scheduleSwitch } = require('./desktop-account.cjs');
const operation = require('./switch-state.cjs');
const OFFICIAL = 'official',
  MCP_NAME = 'api_switcher';
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const EFFECT = '配置已应用。请完整退出并重新打开客户端，以载入新旧对话的来源与模型。';
const API_USAGE_NOTICE =
  '当前为 API 模式，适用于 Codex。聊天 / Work 或部分官方旧会话无法加载时，请选择官方账号并切换。';
const OFFICIAL_RESTART =
  '如刚从自定义 API 切回，请从托盘完整退出后重新打开 ChatGPT 桌面端，再使用“聊天 / Work”或原官方旧会话。';
function createService({
  codexHome,
  bridgeHome,
  hermesHome,
  projectDir = __dirname,
  defaultPort = 47831,
  startService,
} = {}) {
  fs.mkdirSync(bridgeHome, { recursive: true });
  let accounts = createAccounts({
    codexHome,
    bridgeHome,
    codexExe: () => findCodex({ dataHome: bridgeHome }),
  });
  const adapterPath = path.join(bridgeHome, 'adapter.json'),
    currentPath = path.join(bridgeHome, 'current.json');
  const acl = (p) => core.privateAcl(p);
  let listeningPort = null;
  const passed = new Map();
  const fingerprint = (p, m) =>
    crypto
      .createHash('sha256')
      .update(JSON.stringify([p.id, p.baseUrl, p.apiMode, p.apiKey, m]))
      .digest('hex');
  // 转换服务：固定端口与持久令牌（写进 Codex 配置）；target 为当前经转换的配置。
  function adapterSettings() {
    let a = readJson(adapterPath);
    if (!a) {
      a = { port: defaultPort, token: crypto.randomBytes(32).toString('hex'), target: null };
      fs.writeFileSync(adapterPath, JSON.stringify(a, null, 2), { mode: 0o600 });
    }
    return a;
  }
  const saveAdapter = (a) =>
    fs.writeFileSync(adapterPath, JSON.stringify(a, null, 2), { mode: 0o600 });
  async function serviceUp() {
    const port = adapterSettings().port;
    if (listeningPort === port) return true;
    try {
      return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  }
  async function exclusive(fn) {
    if (operation.activeJob(operation.switchJob(bridgeHome)))
      throw Error('账号切换正在进行，请稍后');
    operation.acquire(bridgeHome);
    try {
      return await fn();
    } finally {
      operation.release(bridgeHome);
    }
  }
  function readConfig() {
    try {
      return toml.parse(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return {};
      throw Error('Codex 配置 config.toml 无法解析，请先修复该文件');
    }
  }
  // 首次使用时从 Hermes 导入一次（之后完全独立）；Hermes 不存在时什么也不做。
  let hermesNote = null;
  function ensureImported() {
    if (!hermesHome || store.hermesImported(bridgeHome)) return;
    try {
      const r = store.importHermes(bridgeHome, core.discoverProviders(hermesHome), acl, {
        auto: true,
      });
      if (r.added.length) hermesNote = `已从 Hermes 导入 ${r.added.length} 个配置。`;
    } catch {}
  }
  // 官方登录项。
  const officialModels = () => {
    try {
      return (readJson(path.join(codexHome, 'models_cache.json'))?.models || [])
        .filter((m) => m && m.slug && m.visibility !== 'hide')
        .map((m) => m.slug);
    } catch {
      return [];
    }
  };
  const loginMode = () => {
    const a = readJson(path.join(codexHome, 'auth.json'));
    if (!a) return null;
    return a.auth_mode === 'chatgpt' || a.tokens ? 'chatgpt' : a.OPENAI_API_KEY ? 'apikey' : null;
  };
  function officialModel(c) {
    if (c.model_provider === 'hermes_bridge') {
      try {
        const snap = toml.parse(
          fs.readFileSync(path.join(bridgeHome, 'original-config.toml'), 'utf8'),
        );
        if (snap.model && (!snap.model_provider || snap.model_provider === 'openai'))
          return snap.model;
      } catch {}
    } else if (c.model && (!c.model_provider || c.model_provider === 'openai')) return c.model;
    return officialModels()[0] || undefined;
  }
  const officialInUse = (c) => !c.model_provider || c.model_provider === 'openai';
  function official(c) {
    const model = officialModel(c),
      login = loginMode(),
      account = accounts.status().items.find((a) => a.current);
    return {
      id: OFFICIAL,
      name: account ? '官方 · ' + account.label : 'Codex 官方（ChatGPT 登录）',
      source: 'official',
      baseUrl:
        'Codex 官方服务 · ' +
        (login === 'chatgpt'
          ? '已用 ChatGPT 账号登录'
          : login === 'apikey'
            ? '使用 OpenAI API Key'
            : '未检测到登录，请在 Codex 中登录'),
      apiMode: 'responses',
      model,
      models: [...new Set([model, ...officialModels()].filter(Boolean))],
      login,
      inUse: officialInUse(c),
      access: { mode: 'official' },
      local: false,
    };
  }
  const provider = (id) => {
    const p = store.list(bridgeHome).find((x) => x.id === id);
    if (!p) throw Error('配置不存在，请刷新');
    return p;
  };
  const findByIdOrName = (key) => {
    if (key === OFFICIAL || /^(官方|official)/i.test(String(key))) return OFFICIAL;
    const all = store.list(bridgeHome);
    const p =
      all.find((x) => x.id === key) ||
      all.find((x) => x.name === key) ||
      all.find((x) => x.name.toLowerCase() === String(key).toLowerCase());
    if (!p) throw Error(`没有名为“${key}”的配置。可用：官方、${all.map((x) => x.name).join('、')}`);
    return p.id;
  };
  function inUse(id, c = readConfig()) {
    if (id === OFFICIAL) return officialInUse(c);
    const cur = readJson(currentPath);
    return !!cur && cur.providerId === id && c.model_provider === 'hermes_bridge';
  }
  const publicView = (p, c) => {
    const { apiKey, createdAt, updatedAt, origin, ...rest } = p;
    return {
      ...rest,
      hasKey: !!apiKey,
      inUse: inUse(p.id, c),
      access: store.access(bridgeHome, p),
      local: store.isLocal(p),
    };
  };
  let versionCache;
  async function codexVersion() {
    try {
      const exe = findCodex({ dataHome: bridgeHome });
      if (versionCache?.exe === exe && Date.now() - versionCache.at < 60000)
        return versionCache.task;
      const task = new Promise((resolve) =>
        cp.execFile(
          exe,
          ['--version'],
          { encoding: 'utf8', windowsHide: true, timeout: 10000 },
          (e, out) => resolve(e ? null : out.trim()),
        ),
      );
      versionCache = { exe, at: Date.now(), task };
      return await task;
    } catch {
      return null;
    }
  }
  async function state() {
    ensureImported();
    const c = readConfig(),
      a = adapterSettings(),
      bridged = c.model_provider === 'hermes_bridge';
    const viaAdapter =
      bridged &&
      String(c.model_providers?.hermes_bridge?.base_url || '').startsWith(
        'http://127.0.0.1:' + a.port + '/',
      );
    const version = await codexVersion();
    const cur = readJson(currentPath);
    const currentName = officialInUse(c)
      ? official(c).name
      : bridged
        ? store.list(bridgeHome).find((p) => p.id === cur?.providerId)?.name ||
          c.model_providers?.hermes_bridge?.name ||
          '切换器配置'
        : '其他供应商 ' + c.model_provider;
    // 首次导入提示只返回一次。
    const notice = hermesNote;
    hermesNote = null;
    const catalogFile =
        c.model_catalog_json &&
        (path.isAbsolute(c.model_catalog_json)
          ? c.model_catalog_json
          : path.resolve(codexHome, c.model_catalog_json)),
      catalogData = catalogFile && readJson(catalogFile),
      catalogModels = catalogData?.models;
    const catalog = {
      selected: !!catalogFile,
      readable: Array.isArray(catalogModels),
      count: catalogModels?.length || 0,
      containsCurrent: !!catalogModels?.some((m) => m.slug === c.model),
    };
    return {
      providers: [official(c), ...store.list(bridgeHome).map((p) => publicView(p, c))],
      current: {
        name: currentName,
        model: c.model || null,
        official: officialInUse(c),
        viaAdapter,
        fast: ['fast', 'priority'].includes(c.service_tier) && c.features?.fast_mode !== false,
        serviceTier: c.service_tier || null,
      },
      catalog,
      usage: {
        mode: officialInUse(c) ? 'official' : 'custom_api',
        notice: officialInUse(c) ? '' : API_USAGE_NOTICE,
      },
      adapter: { port: a.port, ready: await serviceUp(), autostart: autostart.status() },
      mcp: { installed: !!c.mcp_servers?.[MCP_NAME] },
      hermesAvailable: !!hermesHome && fs.existsSync(path.join(hermesHome, 'config.yaml')),
      notice,
      effect: operation.readEffect(codexHome, bridgeHome),
      codexVersion: version,
      codexFound: !!version,
    };
  }
  // Codex 模型下拉列表：生成 model_catalog_json 指向的模型目录。条目以 Codex 官方缓存中的模型元数据为模板（同名用其本身，否则用官方默认模型），
  // Codex 要求完整字段，只写名称会被拒绝并退回官方列表。模型 = 当前模型 + 配置中的可选模型 + 供应商模型列表（不超过 80 个时）；当前模型排第一（即默认）。
  const catalogPath = path.join(bridgeHome, 'model-catalog.json');
  async function buildCatalog(p, model, outputPath = catalogPath) {
    const official = (readJson(path.join(codexHome, 'models_cache.json'))?.models || []).filter(
      (m) => m && m.slug,
    );
    if (!official.length) return null;
    const base =
      official
        .filter((m) => m.visibility !== 'hide')
        .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))[0] || official[0];
    // 下拉显示哪些模型由用户决定：配置里填了“其他可选模型”就只用 默认模型 + 这些；没填才用供应商的全部对话模型（不超过 80 个；图片、语音、向量、审核类除外）。
    const extras = (p.models || []).filter((m) => m && m !== p.model);
    let source = 'configured',
      list = [p.model, ...extras],
      truncated = false;
    if (!extras.length) {
      let fetched = [];
      try {
        fetched = await listModels(p);
      } catch {}
      const chatLike = (s) =>
        !/(^|[-_/.])(image|dall-e|tts|whisper|transcribe|audio|realtime|embedding|embed|moderation|rerank)|auto-review/i.test(
          s,
        );
      truncated = fetched.length > 80;
      if (fetched.length && !truncated) {
        source = 'provider';
        list = fetched.filter(chatLike);
      }
    }
    const slugs = [...new Set([model, ...list])].filter(Boolean);
    // 同名官方模型只沿用技术参数（推理档位、上下文等）；名称与说明一律标明来自哪个配置，避免看起来像 Codex 官方模型。
    const models = slugs.map((slug, i) => ({
      ...(official.find((m) => m.slug === slug) || base),
      slug,
      display_name: slug,
      description: `${p.name} · ${slug}`,
      priority: i,
      visibility: 'list',
      upgrade: null,
      availability_nux: null,
    }));
    const tmp = outputPath + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ models }, null, 1));
    fs.renameSync(tmp, outputPath);
    return { path: outputPath, count: models.length, source, truncated };
  }
  // 切回官方时 model_catalog_json 应恢复为用户原有值（通常为空）；本工具生成的目录不算原有值。
  function originalCatalog(c) {
    let v = c.model_catalog_json;
    if (c.model_provider === 'hermes_bridge') {
      try {
        v = toml.parse(
          fs.readFileSync(path.join(bridgeHome, 'original-config.toml'), 'utf8'),
        ).model_catalog_json;
      } catch {
        v = undefined;
      }
    }
    return v && path.resolve(v) !== path.resolve(catalogPath) ? v : undefined;
  }
  // 先测 Responses 直连；不通时按登记协议（登记为 Responses 的按 Chat Completions）再测，可经本机转换接入。
  async function probeProvider(p, model, fast = false) {
    const speedNote = (result) =>
      !fast
        ? ''
        : ['fast', 'priority'].includes(result.serviceTier)
          ? ' 上游回报 Fast 档位；这不代表已测出固定倍速。'
          : result.serviceTier
            ? ' 上游回报 ' + result.serviceTier + ' 档位，本次未确认 Fast。'
            : ' 上游未回报服务档位，不能确认 Fast 是否生效。';
    const direct = await probe(p, model, { fast });
    if (direct.ok) {
      passed.set(fingerprint(p, model), { at: Date.now(), mode: 'direct' });
      return {
        ok: true,
        mode: 'direct',
        ...(fast
          ? {
              serviceTier: direct.serviceTier,
              fastConfirmed: ['fast', 'priority'].includes(direct.serviceTier),
            }
          : {}),
        message: '可直连：Responses 和函数调用通过。' + speedNote(direct),
      };
    }
    const nativeMode = ['chat_completions', 'anthropic_messages'].includes(p.apiMode)
      ? p.apiMode
      : 'chat_completions';
    const native = await probeNative({ ...p, apiMode: nativeMode }, model, { fast });
    if (native.ok) {
      passed.set(fingerprint(p, model), { at: Date.now(), mode: 'adapter', apiMode: nativeMode });
      return {
        ok: true,
        mode: 'adapter',
        ...(fast
          ? {
              serviceTier: native.serviceTier,
              fastConfirmed: ['fast', 'priority'].includes(native.serviceTier),
            }
          : {}),
        message:
          `不支持 Responses 直连（${direct.message}），但原生协议可用：将经本机转换服务接入（转换服务须保持运行；不支持 Codex 内置网页搜索）。` +
          speedNote(native),
      };
    }
    // 限流/服务端错误/超时属于临时故障，不代表协议不兼容。
    const transient = (r) => r.status === 429 || r.status >= 500 || /超时/.test(r.message || '');
    return {
      ok: false,
      transient: transient(direct) && transient(native),
      message: '未通过：' + direct.message + '；' + native.message,
    };
  }
  // 记录检测结果：临时故障不覆盖之前“通过”的记录。
  function recordProbeResult(p, model, r) {
    const prev = store.access(bridgeHome, p);
    if (!r.ok && r.transient && ['direct', 'adapter'].includes(prev.mode)) return;
    store.recordProbe(bridgeHome, p, model, r.ok ? r.mode : 'failed', r.message);
  }
  async function prepareApi({ id, model, fast, autostart: wantAutostart }) {
    model = String(model || '').trim();
    if (!model) throw Error('请选择或填写模型');
    const p = provider(id),
      currentConfig = readConfig(),
      wantsFast =
        fast ??
        (['fast', 'priority'].includes(currentConfig.service_tier) &&
          currentConfig.features?.fast_mode !== false);
    if (wantsFast && p.apiMode === 'anthropic_messages')
      throw Error(
        'Anthropic Messages 转换不支持 Codex Fast，请关闭加速或改用 Responses / Chat Completions。',
      );
    let pass = passed.get(fingerprint(p, model));
    const saved = store.access(bridgeHome, p),
      nativeMode = ['chat_completions', 'anthropic_messages'].includes(p.apiMode)
        ? p.apiMode
        : 'chat_completions';
    const reuseMode = ['direct', 'adapter'].includes(saved.mode) ? saved.mode : null;
    if ((!pass || Date.now() - pass.at > 600000) && reuseMode)
      pass = { at: Date.now(), mode: reuseMode, apiMode: nativeMode, reused: true };
    if (!pass || Date.now() - pass.at > 600000) {
      const r = await probeProvider(p, model, wantsFast);
      if (!wantsFast || r.ok) recordProbeResult(p, model, r);
      if (!r.ok) throw Error('检测未通过，未切换：' + r.message);
      pass = passed.get(fingerprint(p, model));
    }
    const a = adapterSettings();
    if (wantsFast && pass.mode === 'adapter' && pass.apiMode === 'anthropic_messages')
      throw Error('当前使用 Anthropic Messages 转换，不支持 Codex Fast；配置未改动。');
    let target = p;
    if (pass.mode === 'adapter') {
      if (!(await serviceUp())) {
        if (startService) {
          await startService();
          for (let i = 0; i < 20 && !(await serviceUp()); i++)
            await new Promise((r) => setTimeout(r, 500));
        }
        if (!(await serviceUp()))
          throw Error(
            '本机转换服务未运行（端口 ' + a.port + '），无法使用转换模式。请先打开切换器。',
          );
      }
      target = {
        ...p,
        name: p.name + '（经本机转换）',
        baseUrl: 'http://127.0.0.1:' + a.port + '/v1',
        apiKey: a.token,
      };
    } else if (!p.apiKey && !store.isLocal(p)) throw Error('该配置没有密钥，请先在配置管理中填写');
    const original = fs.existsSync(path.join(codexHome, 'config.toml'))
        ? fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')
        : '',
      keyed = { ...target, apiKey: target.apiKey || 'no-key' };
    const stagedCatalog = catalogPath + '.' + crypto.randomUUID() + '.prepared';
    const cleanup = () => fs.rmSync(stagedCatalog, { force: true });
    let catalog;
    try {
      catalog = await buildCatalog(p, model, stagedCatalog).catch(() => null);
      const exe = findCodex({ dataHome: bridgeHome });
      let compatible = await require('./compatibility.cjs').validateConfig(
        core.prepareConfig(original, keyed, model, catalog?.path, fast),
        exe,
      );
      if (!compatible.ok && catalog) {
        catalog = null;
        cleanup();
        compatible = await require('./compatibility.cjs').validateConfig(
          core.prepareConfig(original, keyed, model, undefined, fast),
          exe,
        );
      }
      if (!compatible.ok) throw Error(compatible.message);
    } catch (e) {
      cleanup();
      throw e;
    }
    return {
      label: p.name,
      cleanup,
      apply() {
        if (catalog) fs.renameSync(stagedCatalog, catalogPath);
        core.applySwitch(
          codexHome,
          keyed,
          model,
          bridgeHome,
          catalog ? catalogPath : undefined,
          fast,
        );
        a.target =
          pass.mode === 'adapter' ? { providerId: p.id, model, apiMode: pass.apiMode } : a.target;
        fs.writeFileSync(
          currentPath,
          JSON.stringify({
            providerId: p.id,
            model,
            mode: pass.mode,
            at: new Date().toISOString(),
          }),
          { mode: 0o600 },
        );
        let note = '';
        if (pass.mode === 'adapter') {
          if (wantAutostart !== false && !a.autostartDecided && !autostart.status()) {
            autostart.enable(projectDir);
            a.autostartDecided = true;
            note = '已开启开机自启转换服务（可在切换器中关闭）。';
          } else if (!autostart.status())
            note = '注意：未开启开机自启，重启电脑后需先打开切换器，Codex 才能使用该配置。';
        }
        saveAdapter(a);
        operation.recordEffect(codexHome, bridgeHome, 'restart_required', EFFECT);
        const catalogNote = catalog
          ? `Codex 的模型下拉列表已改为该配置的 ${catalog.count} 个模型（${catalog.source === 'configured' ? '按你在配置中选的模型' : '供应商提供的全部对话模型；想精简可在配置的“其他可选模型”中指定'}${catalog.truncated ? '；供应商模型过多，只列出配置中的模型' : ''}）。`
          : '未能生成 Codex 模型列表（未找到 Codex 官方模型缓存或 Codex 不接受），Codex 模型下拉仍显示官方列表，但实际使用你选择的模型。';
        return {
          mode: pass.mode,
          catalogCount: catalog?.count || 0,
          message: `已切换到「${p.name}」（${pass.mode === 'adapter' ? '经本机转换' : '直连'}，模型 ${model}）。${catalogNote}${note}官方登录凭据未改动。${EFFECT}\n\n${API_USAGE_NOTICE}`,
        };
      },
    };
  }
  const actions = {
    clients: async () => {
      const status = require('./client-status.cjs').clientStatus(codexHome, bridgeHome);
      let runtime = null;
      try {
        runtime = findCodex({ dataHome: bridgeHome });
      } catch {}
      return {
        ...status,
        runtime,
        editors: require('./editor-integration.cjs')
          .editors()
          .map(({ file, ...e }) => e),
      };
    },
    setEnvironment: (input) =>
      exclusive(async () => {
        // 用户选择的目录立即生效并持久保存；账号管理器也要绑定到新目录。
        if (['starting', 'waiting'].includes(accounts.status().login?.status))
          throw Error('请先完成或取消当前登录');
        const home = path.resolve(
            String(input.home || codexHome).replace(/^~(?=[\\/]|$)/, require('node:os').homedir()),
          ),
          exe = String(input.codexExe || '').trim();
        if (!fs.existsSync(home) || !fs.statSync(home).isDirectory())
          throw Error('配置目录不存在，请选择 Codex 实际使用的目录。');
        if (exe && (!fs.existsSync(exe) || !fs.statSync(exe).isFile()))
          throw Error('Codex 程序路径不存在。');
        const file = path.join(bridgeHome, 'settings.json'),
          settings = readJson(file) || {};
        require('./accounts.cjs').writeJson(file, {
          ...settings,
          codexHome: home,
          codexExe: exe || undefined,
        });
        codexHome = home;
        accounts = createAccounts({
          codexHome,
          bridgeHome,
          codexExe: () => findCodex({ dataHome: bridgeHome }),
        });
        versionCache = null;
        return { message: '已改为读取 ' + home + '，后续切换只应用到此目录。' };
      }),
    clientHeartbeat: (input) => require('./client-status.cjs').heartbeat(bridgeHome, input),
    reloadClients: (input) =>
      require('./client-status.cjs').requestReload(codexHome, bridgeHome, input),
    companionPackage: async () => {
      const file = require('./editor-integration.cjs').build(projectDir);
      return {
        filename: 'codex-switcher-companion.vsix',
        base64: fs.readFileSync(file).toString('base64'),
      };
    },
    companionInstall: ({ id }) => require('./editor-integration.cjs').install(id, projectDir),
    threads: (input) => require('./diagnostics.cjs').listThreads(codexHome, input),
    diagnose: async ({ id } = {}) =>
      require('./diagnostics.cjs').diagnose({
        codexHome,
        bridgeHome,
        id,
        clients: require('./client-status.cjs').clientStatus(codexHome, bridgeHome),
      }),
    exportContext: ({ id }) =>
      require('./diagnostics.cjs').exportContext(codexHome, bridgeHome, id),
    desktopSwitch: (input) =>
      exclusive(async () => {
        if (['starting', 'waiting'].includes(accounts.status().login?.status))
          throw Error('请先完成或取消当前登录');
        provider(input.id);
        return scheduleSwitch({ ...input, kind: 'api', codexHome, bridgeHome, projectDir });
      }),
    accounts: async () => {
      await accounts.syncCurrent();
      return accounts.status();
    },
    // 额度属于账号级只读操作，不持有修改全局配置时使用的 exclusive 锁。
    accountQuota: async ({ id } = {}) => {
      const ids = id ? [id] : accounts.status().items.map((a) => a.id);
      return { items: await Promise.all(ids.map((id) => accounts.quota(id))) };
    },
    accountLogin: ({ id } = {}) =>
      exclusive(async () => {
        fs.rmSync(path.join(bridgeHome, 'account-switch.json'), { force: true });
        return accounts.startLogin({ id });
      }),
    accountLoginCancel: () =>
      exclusive(async () => {
        await accounts.cancelLogin();
        return { message: '已取消登录。' };
      }),
    accountRename: ({ id, label }) =>
      exclusive(async () => {
        accounts.rename(id, label);
        return { message: '已修改账号名称。' };
      }),
    accountRemove: ({ id }) =>
      exclusive(async () => {
        accounts.remove(id);
        return { message: '已移除保存的账号。' };
      }),
    accountSwitch: ({ id, fast, reloadEditors = true }) =>
      exclusive(async () => {
        if (['starting', 'waiting'].includes(accounts.status().login?.status))
          throw Error('请先完成或取消当前登录');
        const saved = accounts.status().items.find((a) => a.id === id);
        if (!saved) throw Error('请选择已添加的官方账号');
        const c = readConfig();
        return scheduleSwitch({
          id,
          codexHome,
          bridgeHome,
          reloadEditors,
          fast,
          model: officialModel(c),
          catalog: originalCatalog(c),
        });
      }),
    models: async ({ id, baseUrl, apiMode, apiKey }) => {
      if (id === OFFICIAL) {
        const models = officialModels();
        if (!models.length) throw Error('未找到 Codex 官方模型缓存，请先打开一次 Codex');
        return { models, message: `Codex 官方共 ${models.length} 个模型。` };
      }
      const saved = id ? provider(id) : {};
      const p = {
        ...saved,
        ...(baseUrl ? { baseUrl: String(baseUrl).trim() } : {}),
        ...(apiMode ? { apiMode: String(apiMode) } : {}),
        ...(apiKey ? { apiKey: String(apiKey).trim() } : {}),
      };
      if (!p.baseUrl) throw Error('请先填写 API 地址');
      if (!store.MODES.includes(p.apiMode)) throw Error('协议类型无效');
      const models = await listModels(p);
      if (!models.length) throw Error('供应商返回了空的模型列表，请手动填写模型');
      return { models, message: `获取到 ${models.length} 个模型。` };
    },
    probe: ({ id, model, fast = false }) =>
      exclusive(async () => {
        if (id === OFFICIAL)
          return {
            ok: true,
            mode: 'official',
            message: '官方登录使用 Codex 自己的 ChatGPT 登录，无需检测，可直接应用。',
          };
        const p = provider(id);
        const r = await probeProvider(p, model, fast);
        // 加速请求被拒绝不代表标准接入不可用，不能覆盖之前通过的普通检测。
        if (!fast || r.ok) recordProbeResult(p, model, r);
        if (!r.ok && r.transient)
          r.message += '（这通常是临时的：额度、限流或服务端故障，不代表配置不兼容）';
        return r;
      }),
    // 10 分钟内没有检测过（或检测结果已过期）时自动先检测一次，未通过则不切换。
    switch: ({ id, model, fast, autostart: wantAutostart }) =>
      exclusive(async () => {
        if (id === OFFICIAL) {
          const c = readConfig();
          const m = String(model || officialModel(c) || '').trim() || undefined;
          core.applyOfficial(codexHome, m, originalCatalog(c), undefined, fast);
          fs.rmSync(currentPath, { force: true });
          const threadRouting = await require('./thread-routing.cjs').synchronizeThreads({
            codexHome,
            bridgeHome,
          });
          operation.recordEffect(codexHome, bridgeHome, 'restart_required', EFFECT);
          return {
            mode: 'official',
            threadRouting,
            message: `已切换到 Codex 官方登录（${m ? '模型 ' + m : '由 Codex 选择默认模型'}）。${EFFECT}${officialInUse(c) ? '' : OFFICIAL_RESTART}`,
          };
        }
        const prepared = await prepareApi({ id, model, fast, autostart: wantAutostart });
        try {
          const result = prepared.apply();
          const threadRouting = await require('./thread-routing.cjs').synchronizeThreads({
            codexHome,
            bridgeHome,
          });
          return { ...result, threadRouting };
        } finally {
          prepared.cleanup();
        }
      }),
    restore: () =>
      exclusive(async () => {
        const r = core.restoreOfficial(codexHome, bridgeHome);
        fs.rmSync(currentPath, { force: true });
        const threadRouting = await require('./thread-routing.cjs').synchronizeThreads({
          codexHome,
          bridgeHome,
        });
        if (!r.alreadyOfficial)
          operation.recordEffect(codexHome, bridgeHome, 'restart_required', EFFECT);
        if (r.alreadyOfficial)
          return { threadRouting, message: 'Codex 当前已是官方登录，已同步旧对话来源。' };
        return {
          threadRouting,
          message: `已切回 Codex 官方登录（模型 ${r.model}）。${EFFECT}${OFFICIAL_RESTART}`,
        };
      }),
    autostart: ({ enabled }) =>
      exclusive(async () => {
        if (enabled) autostart.enable(projectDir);
        else autostart.disable();
        const a = adapterSettings();
        a.autostartDecided = true;
        saveAdapter(a);
        return {
          message: enabled ? '已开启：登录 Windows 后自动在后台启动转换服务。' : '已关闭开机自启。',
        };
      }),
    providerAdd: (input) =>
      exclusive(async () => {
        const id = store.add(bridgeHome, input, acl);
        return { id, message: '已新增配置。可检测后应用到 Codex。' };
      }),
    providerUpdate: ({ id, ...input }) =>
      exclusive(async () => {
        if (id === OFFICIAL) throw Error('官方登录配置不能编辑');
        store.update(bridgeHome, id, input, acl);
        const cur = readJson(currentPath);
        return {
          message: inUse(id)
            ? cur?.mode === 'adapter'
              ? '已保存。该配置正在经本机转换使用，新地址/密钥立即生效（模型以应用时为准）。'
              : '已保存。该配置正在被 Codex 直连使用，需重新检测并应用后生效。'
            : '已保存。',
        };
      }),
    providerRemove: ({ id }) =>
      exclusive(async () => {
        if (id === OFFICIAL) throw Error('官方登录配置不能删除');
        if (inUse(id))
          throw Error('该配置正在被 Codex 使用。请先切换到其他配置或官方登录，再删除。');
        const a = adapterSettings(),
          wasTarget = a.target?.providerId === id;
        store.remove(bridgeHome, id, acl);
        if (wasTarget) {
          a.target = null;
          saveAdapter(a);
        }
        return {
          message: '已删除配置。' + (wasTarget ? '之前经它转换建立的 Codex 对话将无法继续。' : ''),
        };
      }),
    importHermes: () =>
      exclusive(async () => {
        if (!hermesHome || !fs.existsSync(path.join(hermesHome, 'config.yaml')))
          throw Error('未找到 Hermes 配置');
        const r = store.importHermes(bridgeHome, core.discoverProviders(hermesHome), acl);
        return {
          message: r.added.length
            ? `已导入 ${r.added.length} 个：${r.added.join('、')}` +
              (r.failed ? `；${r.failed} 个因信息不完整跳过` : '')
            : '没有需要导入的新配置。',
        };
      }),
    // 集成到 Codex：用官方 `codex mcp add/remove` 注册本工具的 MCP 服务。
    integrate: ({ enabled }) =>
      exclusive(async () => {
        const exe = findCodex();
        const env = { ...process.env, CODEX_HOME: codexHome };
        const run = (args) =>
          cp.execFileSync(exe, args, {
            env,
            encoding: 'utf8',
            windowsHide: true,
            timeout: 30000,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        if (readConfig().mcp_servers?.[MCP_NAME]) run(['mcp', 'remove', MCP_NAME]);
        if (enabled)
          run([
            'mcp',
            'add',
            MCP_NAME,
            '--',
            require('./platform.cjs').nodePath(projectDir),
            path.join(projectDir, 'mcp-server.cjs'),
          ]);
        const ok = !!readConfig().mcp_servers?.[MCP_NAME] === !!enabled;
        if (!ok) throw Error('Codex 未能' + (enabled ? '添加' : '移除') + ' MCP 配置');
        return {
          message: enabled
            ? '已集成到 Codex：重启 Codex 后，在对话里说“列出我的 API 配置”“切换到 xxx”“切回官方”即可。'
            : '已从 Codex 移除集成。',
        };
      }),
  };
  // Codex 经 /v1/responses 访问转换服务：每次请求都读取配置库中最新的地址与密钥。
  function handleResponses(req, res, { onError } = {}) {
    const t = adapterSettings().target;
    const fail = (m) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: m, type: 'api_error' } }));
    };
    if (!t) return fail('No adapter target configured');
    let p;
    try {
      p = provider(t.providerId);
    } catch {
      return fail('Adapter provider was deleted');
    }
    return require('./adapter.cjs').handleResponses(
      req,
      res,
      { ...p, apiMode: t.apiMode || p.apiMode },
      t.model,
      { onError: (m) => onError?.(p.id + ' ' + m) },
    );
  }
  return {
    state,
    actions,
    prepareApi,
    handleResponses,
    adapterSettings,
    setListeningPort: (p) => {
      listeningPort = p;
    },
    findByIdOrName,
    OFFICIAL,
    MCP_NAME,
  };
}
module.exports = { createService, OFFICIAL, MCP_NAME };
