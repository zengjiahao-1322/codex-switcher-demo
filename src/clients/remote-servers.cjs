'use strict';

const path = require('node:path'),
  crypto = require('node:crypto'),
  { EventEmitter } = require('node:events');
const { redact, log } = require('../diagnostics/event-log.cjs');
const { readJson, writeJson } = require('../accounts/accounts.cjs');
// 远端配置正文和回执只经过常驻服务内存，不能复用落盘的窗口命令字段。
const pending = new Map();
const commandEvents = new EventEmitter();
const reloads = new Map();
const keyFor = (home, id) => path.resolve(home) + '\0' + id;
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');
function markReload(bridgeHome, id, target) {
  const key = keyFor(bridgeHome, id),
    previous = reloads.get(key);
  if (previous?.timer) clearTimeout(previous.timer);
  const entry = { ...target, clientId: id };
  if (entry.kind === 'install') setInstallStatus(bridgeHome, id, 'installed');
  entry.timer = setTimeout(() => {
    if (reloads.get(key) !== entry) return;
    reloads.delete(key);
    const latest = latestVersions(bridgeHome, entry);
    if (entry.kind === 'install') {
      setInstallStatus(bridgeHome, id, 'notActive');
      log(bridgeHome, 'remote.install', {
        host: entry.host || entry.authority,
        from: entry.from,
        to: entry.to,
        status: 'notActive',
        agentVersion: latest.agentVersion,
        ...(entry.method ? { method: entry.method } : {}),
        ...(entry.reason ? { reason: entry.reason } : {}),
      });
    } else
      log(bridgeHome, 'remote.reload', {
        host: entry.host || entry.authority,
        codexHome: entry.codexHome,
        source: entry.source || 'web',
        status: 'failed',
        ...(entry.method ? { method: entry.method } : {}),
        reason: redact(
          (entry.reason ? entry.reason + '；' : '') +
            '120秒内未确认重载；agentVersion=' +
            (latest.agentVersion || 'null') +
            '，companionVersion=' +
            (latest.companionVersion || 'null'),
        ),
      });
  }, 120000);
  entry.timer.unref?.();
  reloads.set(key, entry);
}

function latestVersions(bridgeHome, entry) {
  const row = readJson(path.join(bridgeHome, 'clients', entry.clientId + '.json'));
  return {
    agentVersion: row?.remoteAgent?.agentVersion || null,
    companionVersion: row?.companionVersion || null,
  };
}
function setInstallStatus(bridgeHome, id, status) {
  const file = path.join(bridgeHome, 'clients', id + '.json'),
    row = readJson(file);
  if (row?.lastAck) {
    row.lastAck.installStatus = status;
    writeJson(file, row);
  }
}
function recordReload(bridgeHome, id, { status, reason } = {}) {
  const key = keyFor(bridgeHome, id),
    reload = reloads.get(key);
  if (!reload) return;
  reloads.delete(key);
  if (reload.timer) clearTimeout(reload.timer);
  if (reload.kind === 'install') {
    setInstallStatus(bridgeHome, id, status === 'confirmed' ? 'active' : 'notActive');
    log(bridgeHome, 'remote.install', {
      host: reload.host || reload.authority,
      from: reload.from,
      to: reload.to,
      status: status === 'confirmed' ? 'active' : 'notActive',
      ...(status === 'confirmed'
        ? { elapsedMs: Date.now() - reload.requestedAt }
        : { agentVersion: latestVersions(bridgeHome, reload).agentVersion }),
      ...(reload.method ? { method: reload.method } : {}),
      ...(reload.reason ? { reason: reload.reason } : {}),
    });
    return;
  }
  log(bridgeHome, 'remote.reload', {
    host: reload.host || reload.authority,
    codexHome: reload.codexHome,
    source: reload.source || 'web',
    status,
    ...(reload.method ? { method: reload.method } : {}),
    ...(status === 'confirmed' && reload.reason ? { reason: reload.reason } : {}),
    ...(status === 'confirmed'
      ? { elapsedMs: Date.now() - reload.requestedAt }
      : {
          reason: redact(reason || reload.reason || '远程窗口未能执行重载'),
        }),
  });
}

function agentStatus(value) {
  if (value == null) return null;
  const string = (item) => {
    if (typeof item !== 'string') throw Error('远端代理状态字段无效');
    return item;
  };
  const platform = string(value.platform),
    codexHome = string(value.codexHome),
    paths = platform === 'win32' ? path.win32 : path.posix;
  if (!paths.isAbsolute(codexHome)) throw Error('远端 Codex 目录必须为绝对路径');
  let current = null;
  if (value.current) {
    let baseUrl = null;
    if (value.current.baseUrl) {
      const url = new URL(string(value.current.baseUrl));
      // 地址是界面元数据，不保存 URL 中的凭据或查询参数。
      baseUrl = url.origin + url.pathname;
    }
    current = {
      model: value.current.model == null ? null : string(value.current.model),
      modelProvider:
        value.current.modelProvider == null ? null : string(value.current.modelProvider),
      baseUrl,
    };
  }
  return {
    agentVersion: string(value.agentVersion),
    startedAt: value.startedAt == null ? null : string(value.startedAt),
    protocol: Number(value.protocol || 0),
    host: string(value.host),
    platform,
    arch: string(value.arch),
    codexHome,
    configExists: !!value.configExists,
    current,
    account: value.account
      ? {
          id: string(value.account.id),
          email: string(value.account.email),
          plan: string(value.account.plan),
          lastRefresh: value.account.lastRefresh == null ? null : string(value.account.lastRefresh),
        }
      : null,
  };
}
function groups(bridgeHome) {
  const found = new Map(),
    known = new Set(
      require('../accounts/accounts.cjs')
        .readJson(path.join(bridgeHome, 'accounts', 'index.json'), [])
        .map((row) => row.id),
    );
  for (const row of require('./client-status.cjs').records(bridgeHome)) {
    if (!row.authority) continue;
    const agent = row.remoteAgent,
      key = JSON.stringify([row.authority, agent?.codexHome || null]);
    if (!found.has(key))
      found.set(key, {
        authority: row.authority,
        codexHome: agent?.codexHome || null,
        host: agent?.host || row.authority.replace(/^ssh-remote\+/, ''),
        platform: agent?.platform || null,
        arch: agent?.arch || null,
        agentVersion: agent?.agentVersion || null,
        agentProtocol: agent?.protocol || 0,
        current: agent?.current || null,
        account: agent?.account
          ? { ...agent.account, id: known.has(agent.account.id) ? agent.account.id : null }
          : null,
        windows: [],
      });
    found.get(key).windows.push({
      id: row.id,
      name: row.name,
      workspace: row.workspace,
      agentVersion: agent?.agentVersion || null,
      agentProtocol: agent?.protocol || 0,
      companionVersion: row.companionVersion,
      remoteAgentState: row.remoteAgentState || null,
      installStatus: row.lastAck?.installStatus || null,
    });
  }
  return [...found.values()];
}
function command(bridgeHome, id) {
  return pending.get(keyFor(bridgeHome, id))?.command || null;
}
function onCommand(bridgeHome, id, listener) {
  const key = keyFor(bridgeHome, id);
  commandEvents.on(key, listener);
  return () => commandEvents.off(key, listener);
}
function dispatch(bridgeHome, id, fields, { timeout = 30000 } = {}) {
  const key = keyFor(bridgeHome, id);
  if (pending.has(key)) throw Error('该窗口正在执行另一项远程命令');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(key);
      reject(Object.assign(Error('等待远端窗口确认命令超时'), { code: 'REMOTE_TIMEOUT' }));
    }, timeout);
    pending.set(key, {
      command: { id: crypto.randomUUID(), ...fields },
      finish(error, result) {
        clearTimeout(timer);
        pending.delete(key);
        if (error) reject(error);
        else resolve(result);
      },
    });
    commandEvents.emit(key);
  });
}
function acknowledge(bridgeHome, input) {
  const entry = pending.get(keyFor(bridgeHome, input.id));
  if (!entry || input.ack !== entry.command.id) return null;
  if (!['completed', 'failed'].includes(input.ackStatus)) throw Error('远程命令回执状态无效');
  const failed = input.ackStatus === 'failed';
  entry.finish(
    failed ? Error(String(input.ackError || '远程命令执行失败')) : null,
    input.ackResult,
  );
  return {
    id: input.ack,
    status: failed ? 'failed' : entry.command.reload ? 'reload_requested' : 'completed',
    error: failed ? '远程命令执行失败，请查看编辑器提示' : null,
    remote: true,
    at: Date.now(),
  };
}
function confirmsReload(input, previous) {
  return (
    input.remoteType === 'ssh-remote' &&
    input.authority === previous.authority &&
    input.remoteAgent?.codexHome === previous.remoteAgent?.codexHome &&
    input.remoteAgent?.agentVersion === input.companionVersion &&
    input.remoteAgent?.protocol >= 3 &&
    !!input.remoteAgent
  );
}
function hasReload(bridgeHome, id) {
  return reloads.has(keyFor(bridgeHome, id));
}
function confirmsRemoteRestart(bridgeHome, id, input) {
  const reload = reloads.get(keyFor(bridgeHome, id));
  return !!(
    reload?.method === 'remoteHostExit' &&
    input.authority === reload.authority &&
    (!reload.codexHome || input.remoteAgent?.codexHome === reload.codexHome) &&
    input.remoteAgent?.startedAt &&
    Date.parse(input.remoteAgent.startedAt) > reload.requestedAt &&
    input.remoteAgent.agentVersion === input.companionVersion &&
    input.remoteAgent.protocol >= 3 &&
    (reload.kind !== 'install' || input.remoteAgent.agentVersion === reload.to)
  );
}
function windowFor(bridgeHome, group) {
  return require('./client-status.cjs')
    .records(bridgeHome)
    .find(
      (row) =>
        row.authority === group.authority &&
        row.remoteType === 'ssh-remote' &&
        row.remoteAgent?.codexHome === group.codexHome &&
        row.remoteAgent.agentVersion === row.companionVersion &&
        row.remoteAgent.protocol >= 3,
    );
}
function redactReason(error, ...secrets) {
  let reason = String(error.message);
  for (const value of secrets.flatMap((item) =>
    typeof item === 'string'
      ? [item]
      : item
        ? [item.OPENAI_API_KEY, ...Object.values(item.tokens || {})]
        : [],
  ))
    if (typeof value === 'string' && value) reason = reason.split(value).join('[已隐藏]');
  return redact(reason);
}
async function readAuth(bridgeHome, windowId) {
  const result = await dispatch(bridgeHome, windowId, { type: 'remoteApply', step: 'readAuth' });
  if (typeof result?.text !== 'string' || digest(result.text) !== result.sha256)
    throw Error('远端登录读取结果或校验值无效');
  let auth = null;
  if (result.text) {
    try {
      auth = JSON.parse(result.text);
    } catch {
      throw Error('远端auth.json无法解析，未修改登录');
    }
  }
  return { ...result, auth };
}
async function apply(bridgeHome, authority, source, origin = 'web') {
  if (typeof authority !== 'string' || !/^ssh-remote\+[^\s/\\?#]{1,240}$/.test(authority))
    throw Error('请选择已连接的 Remote-SSH 服务器');
  const targets = groups(bridgeHome).filter((group) => group.authority === authority),
    // 配置的 SHA 无法区分不同官方账号，日志单独记录脱敏目标。
    target = source.auth
      ? { account: require('../accounts/accounts.cjs').identity(source.auth).email }
      : { provider: source.provider.name, model: source.model };
  if (!targets.length) throw Error('这台服务器当前没有已连接的窗口');
  return Promise.all(
    targets.map(async (group) => {
      const started = performance.now();
      const result = { codexHome: group.codexHome, status: 'skipped' };
      const skip = (reason) => {
        log(bridgeHome, 'remote.sync', {
          ...target,
          source: origin,
          host: group.host,
          codexHome: group.codexHome,
          status: 'skipped',
          reason,
        });
        return { ...result, reason };
      };
      if (!group.agentVersion) return skip('尚未接入远端代理');
      const window = windowFor(bridgeHome, group);
      if (!window) return skip('请更新远端代理，使其版本与伴随扩展一致');
      let original = '',
        step = 'read',
        previousAuth = null;
      try {
        const read = await dispatch(bridgeHome, window.id, { type: 'remoteApply', step: 'read' });
        if (typeof read?.text !== 'string' || digest(read.text) !== read.sha256)
          throw Error('远端配置读取结果或校验值无效');
        original = read.text;
        const paths = group.platform === 'win32' ? path.win32 : path.posix,
          catalogPath = source.catalog
            ? paths.join(group.codexHome, 'switcher-model-catalog.json')
            : undefined;
        let text;
        if (source.auth) {
          let config;
          try {
            config = require('smol-toml').parse(original);
          } catch {
            throw Error('服务器配置无法解析，未写入官方登录');
          }
          if (['keyring', 'ephemeral'].includes(config.cli_auth_credentials_store))
            throw Error(
              '服务器使用' +
                config.cli_auth_credentials_store +
                '凭证存储，写入auth.json不会生效；未修改配置或登录',
            );
          step = 'readAuth';
          previousAuth = await readAuth(bridgeHome, window.id);
          const official = !config.model_provider || config.model_provider === 'openai',
            ownCatalog = paths.join(group.codexHome, 'switcher-model-catalog.json');
          text = require('../config/core.cjs').prepareOfficialConfig(
            original,
            source.model ?? (official ? config.model : undefined),
            config.model_catalog_json !== ownCatalog ? config.model_catalog_json : undefined,
            'file',
          );
        } else
          text = require('../config/core.cjs').prepareConfig(
            original,
            source.provider,
            source.model,
            catalogPath,
          );
        const authText = source.auth ? JSON.stringify(source.auth, null, 2) : null,
          write = {
            type: 'remoteApply',
            step: 'write',
            text,
            expectedSha256: read.sha256,
            catalog: source.catalog || null,
            reload: true,
            ...(authText ? { auth: { text: authText, expectedSha256: previousAuth.sha256 } } : {}),
          };
        step = 'write';
        const requestedAt = Date.now();
        const written = await dispatch(bridgeHome, window.id, write);
        if (written?.ok !== true || written.sha256 !== digest(text))
          throw Error('远端未确认写入目标配置');
        if (authText && written.authSha256 !== digest(authText))
          throw Error('远端未确认写入目标登录');
        markReload(bridgeHome, window.id, {
          host: group.host,
          authority: group.authority,
          codexHome: group.codexHome,
          requestedAt,
          source: origin,
          method: written?.reload?.method || 'remoteHostExit',
          reason: written?.reload?.reason || null,
        });
        const others = group.windows.filter((item) => item.id !== window.id);
        await Promise.all(
          others.map(async (item) => {
            const requestedAt = Date.now();
            const response = await dispatch(bridgeHome, item.id, {
              type: 'remoteReload',
              reload: true,
            });
            markReload(bridgeHome, item.id, {
              host: group.host,
              authority: group.authority,
              codexHome: group.codexHome,
              requestedAt,
              source: origin,
              method: response.reload.method,
              reason: response.reload.reason || null,
            });
          }),
        );
        log(bridgeHome, 'remote.sync', {
          ...target,
          source: origin,
          host: group.host,
          codexHome: group.codexHome,
          step,
          sha256: written.sha256.slice(0, 8),
          status: 'synced',
          elapsedMs: Math.round(performance.now() - started),
        });
        return { ...result, status: 'synced' };
      } catch (error) {
        // 远端错误可能引用配置；不把正文或本次密钥写入任务、日志和诊断。
        const reason = redactReason(
          error,
          original,
          source.provider?.apiKey,
          source.auth,
          previousAuth?.text,
          previousAuth?.auth,
        );
        log(bridgeHome, 'remote.sync', {
          ...target,
          source: origin,
          host: group.host,
          codexHome: group.codexHome,
          step: error.code === 'REMOTE_TIMEOUT' ? 'timeout' : step,
          status: 'failed',
          reason,
        });
        return { ...result, status: 'failed', reason };
      }
    }),
  );
}

module.exports = {
  agentStatus,
  groups,
  command,
  onCommand,
  dispatch,
  acknowledge,
  confirmsReload,
  hasReload,
  windowFor,
  readAuth,
  redactReason,
  markReload,
  recordReload,
  confirmsRemoteRestart,
  apply,
};
