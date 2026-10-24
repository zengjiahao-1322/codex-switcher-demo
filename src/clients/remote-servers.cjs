'use strict';

const path = require('node:path'),
  crypto = require('node:crypto');
const { redact, log } = require('../diagnostics/event-log.cjs');
// 远端配置正文和回执只经过常驻服务内存，不能复用落盘的窗口命令字段。
const pending = new Map();
const keyFor = (home, id) => path.resolve(home) + '\0' + id;
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');

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
    host: string(value.host),
    platform,
    arch: string(value.arch),
    codexHome,
    configExists: !!value.configExists,
    current,
  };
}
function groups(bridgeHome) {
  const found = new Map();
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
        current: agent?.current || null,
        windows: [],
      });
    found.get(key).windows.push({
      id: row.id,
      name: row.name,
      workspace: row.workspace,
      agentVersion: agent?.agentVersion || null,
      companionVersion: row.companionVersion,
    });
  }
  return [...found.values()];
}
function command(bridgeHome, id) {
  return pending.get(keyFor(bridgeHome, id))?.command || null;
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
    !!input.remoteAgent
  );
}
async function apply(bridgeHome, authority, source) {
  if (typeof authority !== 'string' || !/^ssh-remote\+[^\s/\\?#]{1,240}$/.test(authority))
    throw Error('请选择已连接的 Remote-SSH 服务器');
  const clients = require('./client-status.cjs'),
    rows = clients.records(bridgeHome),
    targets = groups(bridgeHome).filter((group) => group.authority === authority);
  if (!targets.length) throw Error('这台服务器当前没有已连接的窗口');
  return Promise.all(
    targets.map(async (group) => {
      const result = { codexHome: group.codexHome, status: 'skipped' };
      const skip = (reason) => {
        log(bridgeHome, 'remote.sync', {
          host: group.host,
          codexHome: group.codexHome,
          status: 'skipped',
          reason,
        });
        return { ...result, reason };
      };
      if (!group.agentVersion) return skip('尚未接入远端代理');
      const window = rows.find(
        (row) =>
          row.authority === group.authority &&
          row.remoteType === 'ssh-remote' &&
          row.remoteAgent?.codexHome === group.codexHome &&
          row.remoteAgent.agentVersion === row.companionVersion,
      );
      if (!window) return skip('请更新远端代理，使其版本与伴随扩展一致');
      let original = '',
        step = 'read';
      try {
        const read = await dispatch(bridgeHome, window.id, { type: 'remoteApply', step: 'read' });
        if (typeof read?.text !== 'string' || digest(read.text) !== read.sha256)
          throw Error('远端配置读取结果或校验值无效');
        original = read.text;
        const paths = group.platform === 'win32' ? path.win32 : path.posix,
          catalogPath = source.catalog
            ? paths.join(group.codexHome, 'switcher-model-catalog.json')
            : undefined,
          text = require('../config/core.cjs').prepareConfig(
            original,
            source.provider,
            source.model,
            catalogPath,
          ),
          write = {
            type: 'remoteApply',
            step: 'write',
            text,
            expectedSha256: read.sha256,
            catalog: source.catalog,
            reload: true,
          };
        step = 'write';
        const written = await dispatch(bridgeHome, window.id, write);
        if (written?.ok !== true || written.sha256 !== digest(text))
          throw Error('远端未确认写入目标配置');
        const others = group.windows.filter((item) => item.id !== window.id);
        if (others.length)
          clients.requestReload(null, bridgeHome, {
            stoppedEditors: others.map((item) => ({
              editorId: item.id,
              name: item.name,
              workspace: item.workspace,
            })),
            onlyStopped: true,
          });
        log(bridgeHome, 'remote.sync', {
          host: group.host,
          codexHome: group.codexHome,
          step,
          sha256: written.sha256.slice(0, 8),
          status: 'synced',
        });
        return { ...result, status: 'synced' };
      } catch (error) {
        // 远端错误可能引用配置；不把正文或本次密钥写入任务、日志和诊断。
        let reason = String(error.message);
        for (const value of [original, source.provider.apiKey])
          if (value) reason = reason.split(value).join('[已隐藏]');
        reason = redact(reason);
        log(bridgeHome, 'remote.sync', {
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
  dispatch,
  acknowledge,
  confirmsReload,
  apply,
};
