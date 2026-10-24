'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const toml = require('smol-toml');
const { identity, readJson } = require('./accounts.cjs');
const remote = require('../clients/remote-servers.cjs');
const { log } = require('../diagnostics/event-log.cjs');
const refreshed = (auth) => Date.parse(auth?.last_refresh) || 0;
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');

// 只合并同一已保存账号；在途任务按账号合并，不维护远端清单或凭证指纹。
function createRemoteCredentials({ bridgeHome, getAccounts }) {
  const tasks = new Map();
  async function synchronizeAccount(id) {
    const accounts = getAccounts();
    const saved = readJson(path.join(bridgeHome, 'accounts', 'index.json'), []);
    if (!saved.some((row) => row.id === id)) return null;
    await accounts.syncCurrent();
    let latest = accounts.getAuth(id),
      direction = 'remote→saved',
      target = '已连接的同账号目录';
    const snapshots = [];
    try {
      const groups = remote.groups(bridgeHome).filter((group) => group.account?.id === id);
      // 时间相同便不用读取登录正文；每次已有的心跳/账号刷新都可幂等触发。
      if (
        groups.some((group) => (Date.parse(group.account.lastRefresh) || 0) !== refreshed(latest))
      ) {
        for (const group of groups) {
          const window = remote.windowFor(bridgeHome, group);
          if (!window) continue;
          target = group.authority + ':' + group.codexHome;
          const config = await remote.dispatch(bridgeHome, window.id, {
            type: 'remoteApply',
            step: 'read',
          });
          let mode;
          try {
            mode = toml.parse(config.text).cli_auth_credentials_store;
          } catch {
            throw Error('服务器配置无法解析，未同步登录');
          }
          if (['keyring', 'ephemeral'].includes(mode)) {
            log(bridgeHome, 'official.sync', {
              account: identity(latest).email,
              direction,
              target,
              status: 'skipped',
              reason: '服务器使用' + mode + '凭证存储',
            });
            continue;
          }
          const saved = await remote.readAuth(bridgeHome, window.id);
          // 读取期间用户可能已换号；不要把本次目标账号再推过去。
          if (identity(saved.auth)?.id !== id) {
            log(bridgeHome, 'official.sync', {
              account: identity(latest).email,
              direction,
              target,
              status: 'skipped',
              reason: '服务器当前登录已变化',
            });
            continue;
          }
          snapshots.push({ group, window, ...saved });
        }
        for (const snapshot of snapshots)
          if (accounts.mergeAuth(snapshot.auth))
            log(bridgeHome, 'official.sync', {
              account: identity(snapshot.auth).email,
              direction,
              target: snapshot.group.authority + ':' + snapshot.group.codexHome,
              status: 'saved',
            });
      }
      // 远端读取耗时期间，本机或额度进程也可能刚续期；合并前再读一次真实文件。
      accounts.captureCurrent();
      latest = accounts.getAuth(id);
      direction = 'saved→local';
      target = '本机当前登录';
      if (accounts.syncLocalAuth(latest))
        log(bridgeHome, 'official.sync', {
          account: identity(latest).email,
          direction,
          target,
          status: 'synced',
        });
      const text = JSON.stringify(latest, null, 2);
      for (const snapshot of snapshots) {
        if (refreshed(snapshot.auth) >= refreshed(latest)) continue;
        direction = 'saved→remote';
        target = snapshot.group.authority + ':' + snapshot.group.codexHome;
        const written = await remote.dispatch(bridgeHome, snapshot.window.id, {
          type: 'remoteApply',
          step: 'write',
          text: null,
          expectedSha256: null,
          catalog: null,
          auth: { text, expectedSha256: snapshot.sha256 },
          reload: false,
        });
        if (written?.ok !== true || written.authSha256 !== digest(text))
          throw Error('服务器未确认写入最新登录');
        log(bridgeHome, 'official.sync', {
          account: identity(latest).email,
          direction,
          target,
          status: 'synced',
        });
      }
      return latest;
    } catch (error) {
      const reason = remote.redactReason(
        error,
        latest,
        ...snapshots.flatMap((snapshot) => [snapshot.text, snapshot.auth]),
      );
      log(bridgeHome, 'official.sync', {
        account: identity(latest)?.email || id,
        direction,
        target,
        status: 'failed',
        reason,
        code: error.code || null,
      });
      throw Error(reason);
    }
  }
  function synchronize(id) {
    if (tasks.has(id)) return tasks.get(id);
    const task = synchronizeAccount(id).finally(() => tasks.delete(id));
    tasks.set(id, task);
    return task;
  }
  function observe(id) {
    synchronize(id).catch((error) => console.error('官方登录互通失败：' + error.message));
  }
  return { synchronize, observe };
}

module.exports = { createRemoteCredentials };
