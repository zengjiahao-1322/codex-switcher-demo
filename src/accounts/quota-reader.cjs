'use strict';

const path = require('node:path');
const { officialErrorKind } = require('./official-session.cjs');
const { log } = require('../diagnostics/event-log.cjs');

function subscriptionFrom(body, accountId) {
  const account = body.accounts?.[accountId],
    until = account?.entitlement?.expires_at || account?.entitlement?.renews_at;
  return until && Number.isFinite(Date.parse(until))
    ? {
        until,
        willRenew: account.last_active_subscription?.will_renew ?? null,
        checkedAt: new Date().toISOString(),
      }
    : null;
}
async function readSubscription(authFile, { bridgeHome = null, account = null } = {}) {
  let status = 'failed',
    httpCode = null,
    curlCode = null,
    hasDate = false;
  try {
    const auth = JSON.parse(require('node:fs').readFileSync(authFile, 'utf8')),
      home = path.dirname(authFile),
      env = require('../platform/platform.cjs').codexEnv(home),
      quote = (s) => '"' + String(s).replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
    const config =
      [
        'url = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27"',
        'header = ' + quote('Authorization: Bearer ' + auth.tokens.access_token),
        'header = ' + quote('ChatGPT-Account-Id: ' + auth.tokens.account_id),
        'header = "originator: codex_cli_rs"',
        'header = ' +
          quote(
            'User-Agent: codex_cli_rs/0.163.0 (' +
              require('node:os').type() +
              ' ' +
              require('node:os').release() +
              '; ' +
              process.arch +
              ')',
          ),
        'header = "Accept: application/json"',
      ].join('\n') + '\n';
    const result = await new Promise((resolve) => {
      const args = [
        '--config',
        '-',
        '--silent',
        '--show-error',
        '--connect-timeout',
        '10',
        '--max-time',
        '20',
        '--write-out',
        '\n__SWITCHER_HTTP_STATUS__:%{http_code}',
      ];
      if (process.platform === 'win32') args.push('--ssl-revoke-best-effort');
      const child = require('node:child_process').execFile(
        process.platform === 'win32' ? 'curl.exe' : '/usr/bin/curl',
        args,
        { env, encoding: 'utf8', windowsHide: true, timeout: 25000, maxBuffer: 2 * 1024 * 1024 },
        (error, stdout) => {
          const marker = '\n__SWITCHER_HTTP_STATUS__:',
            at = stdout.lastIndexOf(marker),
            code = at >= 0 ? Number(stdout.slice(at + marker.length).trim()) : null,
            text = at >= 0 ? stdout.slice(0, at) : stdout;
          resolve({ error, code: Number.isFinite(code) && code > 0 ? code : null, text });
        },
      );
      child.stdin.on('error', () =>
        resolve({ error: Error('curl stdin failed'), code: null, text: '' }),
      );
      child.stdin.end(config);
    });
    httpCode = result.code;
    if (result.error && httpCode === null) curlCode = result.error.code ?? null;
    if (result.error || httpCode === null || httpCode < 200 || httpCode >= 300) return null;
    let body;
    try {
      body = JSON.parse(result.text);
    } catch {
      return null;
    }
    const subscription = subscriptionFrom(body, auth.tokens.account_id);
    status = 'ok';
    hasDate = !!subscription?.until;
    return subscription;
  } finally {
    if (bridgeHome)
      log(bridgeHome, 'official.subscription', {
        account,
        status,
        ...(httpCode !== null ? { httpCode } : { curlCode }),
        hasDate,
      });
  }
}

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

function tokenClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url'));
  } catch {
    return {};
  }
}

function createQuotaReader({
  bridgeHome,
  root,
  load,
  authFile,
  captureCurrent,
  currentId = () => null,
  openSession,
  readJson,
  writeJson,
  readSubscription,
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
    const selected = load().find((account) => account.id === id);
    if (!selected) throw Error('账号不存在，请重新选择');
    const file = path.join(root, id, 'quota.json'),
      previous = readJson(file, {});
    if (currentId() === id) {
      const auth = readJson(authFile(id)),
        claims = tokenClaims(auth?.tokens?.access_token),
        expiresAt = Number(claims.exp),
        hasExpiry = Number.isFinite(expiresAt),
        nearExpiry = hasExpiry && expiresAt <= Math.floor(Date.now() / 1000) + 5 * 60,
        scheduled =
          !hasExpiry &&
          Date.parse(auth?.last_refresh || '') <= Date.now() - 8 * 24 * 60 * 60 * 1000;
      if (nearExpiry || scheduled) {
        const value = {
          status: 'deferred',
          reason: 'token_refresh_pending',
          message:
            '当前账号的登录即将由 Codex 自己续期，为避免顶掉正在使用的登录暂不查询；Codex 刷新后会自动恢复。',
          ...(previous.checkedAt ? { checkedAt: previous.checkedAt } : {}),
        };
        writeJson(file, value);
        return { id, ...value };
      }
    }
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
      const results = await Promise.allSettled([
        check.rpc('account/rateLimits/read', {}),
        readSubscription
          ? readSubscription(authFile(id), { bridgeHome, account: selected.email })
          : null,
      ]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      const buckets = quotaBuckets(results[0].value),
        subscription = results[1].value;
      if (!buckets.length) throw Error('官方服务未返回额度');
      const value = {
        status: 'ok',
        checkedAt: new Date().toISOString(),
        buckets,
        ...(subscription?.until ? { subscriptionUntil: subscription.until } : {}),
        ...(subscription?.checkedAt ? { subscriptionCheckedAt: subscription.checkedAt } : {}),
        ...(subscription ? { subscriptionWillRenew: subscription.willRenew } : {}),
      };
      writeJson(file, value);
      return { id, ...value };
    } catch (error) {
      const failure = quotaError(error);
      log(bridgeHome, 'official.error', {
        op: 'quota',
        account: selected.email,
        kind: failure.kind,
        code: error.code ?? null,
        message: error.message,
      });
      const value = {
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

module.exports = {
  createQuotaReader,
  quotaBuckets,
  quotaError,
  readSubscription,
  subscriptionFrom,
};
