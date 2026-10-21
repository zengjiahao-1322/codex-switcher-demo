'use strict';

const path = require('node:path');
const { officialErrorKind } = require('./official-session.cjs');

function quotaBuckets(result) {
  const buckets =
    result.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
      ? Object.entries(result.rateLimitsByLimitId)
      : result.rateLimits
        ? [['codex', result.rateLimits]]
        : [];
  return buckets.map(([id, bucket]) => ({
    id: bucket.limitId || id,
    name: bucket.limitName || bucket.limitId || id,
    plan: bucket.planType || null,
    windows: ['primary', 'secondary']
      .filter((key) => bucket[key])
      .map((key) => {
        const window = bucket[key],
          used =
            typeof window.usedPercent === 'number'
              ? Math.max(0, Math.min(100, window.usedPercent))
              : null;
        return {
          key,
          usedPercent: used,
          remainingPercent: used === null ? null : 100 - used,
          minutes: window.windowDurationMins ?? null,
          resetsAt: window.resetsAt ?? null,
        };
      }),
    credits: bucket.credits
      ? { unlimited: !!bucket.credits.unlimited, balance: bucket.credits.balance ?? null }
      : null,
  }));
}

function quotaError(error) {
  const kind = officialErrorKind(error);
  if (error.code === -32601)
    return {
      kind: 'runtime_error',
      message: '当前 Codex 版本不支持额度查询，请更新官方扩展或桌面版。',
    };
  if (kind === 'runtime_error') return { kind, message: error.message };
  if (kind === 'auth_invalid')
    return { kind, message: '此账号登录已失效，请点此账号的“重新登录”。' };
  if (kind === 'network_error')
    return { kind, message: '无法连接官方额度服务，请检查网络或代理后重试。' };
  return {
    kind: 'quota_error',
    message:
      '额度查询失败' +
      (error.code ? '（' + error.code + '）' : '') +
      '，请稍后重试；尚未确认此账号登录失效。',
  };
}

function createQuotaReader({
  root,
  load,
  authFile,
  captureCurrent,
  openSession,
  readJson,
  writeJson,
}) {
  const tasks = new Map(),
    waiting = [];
  let active = 0;
  // 在读取器内统一限流，网页的多个单账号请求和批量请求共用两个名额。
  function drain() {
    while (active < 2 && waiting.length) {
      const { id, resolve, reject } = waiting.shift();
      active++;
      readQuota(id)
        .then(resolve, reject)
        .finally(() => {
          active--;
          drain();
        });
    }
  }
  function quota(id) {
    if (tasks.has(id)) return tasks.get(id);
    const task = new Promise((resolve, reject) => {
      waiting.push({ id, resolve, reject });
    }).finally(() => tasks.delete(id));
    tasks.set(id, task);
    drain();
    return task;
  }
  async function readQuota(id) {
    captureCurrent();
    if (!load().some((account) => account.id === id)) throw Error('账号不存在，请重新选择');
    const file = path.join(root, id, 'quota.json'),
      previous = readJson(file, {});
    let check;
    try {
      check = openSession(path.dirname(authFile(id)));
      await check.ready();
      // 刷新额度不等于强制刷新 OAuth 令牌，避免每次查询额外请求登录服务。
      const account = await check.rpc('account/read', { refreshToken: false });
      if (account.account?.type !== 'chatgpt')
        throw Object.assign(Error('未读到此账号的官方登录，请重新登录此账号。'), {
          code: 'AUTH_REQUIRED',
        });
      const result = await check.rpc('account/rateLimits/read', {}),
        buckets = quotaBuckets(result);
      if (!buckets.length) throw Error('官方服务未返回额度');
      const value = { status: 'ok', checkedAt: new Date().toISOString(), buckets };
      writeJson(file, value);
      return { id, ...value };
    } catch (error) {
      const failure = quotaError(error),
        value = {
          ...previous,
          status: 'error',
          attemptedAt: new Date().toISOString(),
          errorKind: failure.kind,
          error: failure.message,
        };
      writeJson(file, value);
      return { id, ...value };
    } finally {
      await check?.close();
    }
  }
  return { quota };
}

module.exports = { createQuotaReader, quotaBuckets, quotaError };
