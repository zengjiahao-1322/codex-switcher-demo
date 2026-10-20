'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  { spawn } = require('node:child_process');
const { findCodex } = require('./runtime.cjs'),
  { switchJob } = require('./switch-state.cjs');
function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function claims(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  } catch {
    return {};
  }
}
function identity(auth) {
  if (!auth?.tokens?.access_token || !auth.tokens.account_id) return null;
  const access = claims(auth.tokens.access_token),
    id = claims(auth.tokens.id_token || ''),
    a = access['https://api.openai.com/auth'] || id['https://api.openai.com/auth'] || {};
  const accountId = auth.tokens.account_id,
    userId = a.chatgpt_user_id || a.user_id || access.sub || id.sub || '';
  return {
    id: crypto
      .createHash('sha256')
      .update(accountId + '\0' + userId)
      .digest('hex')
      .slice(0, 20),
    accountId,
    email: id.email || access['https://api.openai.com/profile']?.email || '',
    plan: a.chatgpt_plan_type || 'unknown',
  };
}
function quotaBuckets(result) {
  const buckets =
    result.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
      ? Object.entries(result.rateLimitsByLimitId)
      : result.rateLimits
        ? [['codex', result.rateLimits]]
        : [];
  return buckets.map(([id, b]) => ({
    id: b.limitId || id,
    name: b.limitName || b.limitId || id,
    plan: b.planType || null,
    windows: ['primary', 'secondary']
      .filter((key) => b[key])
      .map((key) => {
        const w = b[key],
          used =
            typeof w.usedPercent === 'number' ? Math.max(0, Math.min(100, w.usedPercent)) : null;
        return {
          key,
          usedPercent: used,
          remainingPercent: used === null ? null : 100 - used,
          minutes: w.windowDurationMins ?? null,
          resetsAt: w.resetsAt ?? null,
        };
      }),
    credits: b.credits
      ? { unlimited: !!b.credits.unlimited, balance: b.credits.balance ?? null }
      : null,
  }));
}
function createAccounts({ codexHome, bridgeHome, codexExe, spawnProcess = spawn }) {
  const root = path.join(bridgeHome, 'accounts'),
    indexFile = path.join(root, 'index.json'),
    liveFile = path.join(codexHome, 'auth.json');
  const load = () => readJson(indexFile, []),
    authFile = (id) => path.join(root, id, 'auth.json');
  let login = null,
    session = null,
    keychainAuth = null,
    keychainMode = false,
    keychainRequired = false,
    credentialsNotice = null,
    keychainTask,
    lastKeychainCheck = 0;
  const quotaTasks = new Map();
  const currentAuth = () =>
    keychainMode
      ? keychainAuth || (keychainRequired ? null : readJson(liveFile))
      : readJson(liveFile);
  // macOS 可能将官方登录保存在钥匙串。仅在配置要求时读取，并缓存结果，
  // 避免页面轮询反复调用系统工具；显式 keyring 模式不能误用旧 auth.json。
  async function syncCurrent({ force = false } = {}) {
    if (process.platform !== 'darwin') return;
    let mode;
    try {
      mode = require('smol-toml').parse(
        fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'),
      ).cli_auth_credentials_store;
    } catch {}
    keychainRequired = mode === 'keyring';
    keychainMode = keychainRequired || mode === 'auto';
    if (!keychainMode) {
      credentialsNotice = null;
      return;
    }
    if (keychainTask) return keychainTask;
    if (!force && Date.now() - lastKeychainCheck < 30000) return;
    let home = codexHome;
    try {
      home = fs.realpathSync(home);
    } catch {}
    const key = 'cli|' + crypto.createHash('sha256').update(home).digest('hex').slice(0, 16);
    keychainTask = new Promise((resolve) =>
      require('node:child_process').execFile(
        '/usr/bin/security',
        ['find-generic-password', '-s', 'Codex Auth', '-a', key, '-w'],
        { encoding: 'utf8', timeout: 10000 },
        (error, out) => {
          lastKeychainCheck = Date.now();
          keychainAuth = null;
          if (!error)
            try {
              keychainAuth = JSON.parse(out);
            } catch {}
          credentialsNotice =
            keychainRequired && !keychainAuth
              ? '此目录使用系统钥匙串，但未能读取登录。请允许钥匙串访问，或用“添加账号”完成官方登录。'
              : null;
          resolve();
        },
      ),
    ).finally(() => {
      keychainTask = null;
    });
    await keychainTask;
  }
  function remember(auth, { pendingLogin = false } = {}) {
    const info = identity(auth);
    if (!info) return null;
    const rows = load(),
      index = rows.findIndex((a) => a.id === info.id),
      old = rows[index];
    const row = {
      ...old,
      ...info,
      label: old?.label || info.email || 'ChatGPT 账号',
      savedAt: new Date().toISOString(),
      pendingLogin,
    };
    writeJson(authFile(info.id), auth);
    if (index < 0) rows.push(row);
    else rows[index] = row;
    writeJson(indexFile, rows);
    return row;
  }
  function captureCurrent() {
    const auth = currentAuth(),
      info = identity(auth);
    if (!info) return null;
    const old = load().find((a) => a.id === info.id);
    if (old?.pendingLogin) return old;
    // 桌面进程可能仍持有刷新前的旧令牌，不能覆盖较新的已保存登录。
    const saved = old && readJson(authFile(info.id));
    if (saved && Date.parse(saved.last_refresh) > Date.parse(auth.last_refresh)) return old;
    if (old && JSON.stringify(readJson(authFile(info.id))) === JSON.stringify(auth)) return old;
    return remember(auth);
  }
  function status() {
    captureCurrent();
    const current = identity(currentAuth());
    return {
      items: load().map((row) => ({
        ...row,
        current: row.id === current?.id,
        quota: readJson(path.join(root, row.id, 'quota.json')),
      })),
      credentialsNotice,
      login: login ? { ...login } : null,
      switchJob: switchJob(bridgeHome),
    };
  }
  function apply(id, model, catalog) {
    const selected = load().find((a) => a.id === id);
    if (!selected) throw Error('请选择一个已保存的官方账号');
    captureCurrent();
    const auth = readJson(authFile(id));
    require('./core.cjs').applyOfficial(codexHome, model, catalog, 'file');
    writeJson(liveFile, auth);
    keychainMode = false;
    keychainAuth = null;
    credentialsNotice = null;
    remember(auth);
    fs.rmSync(path.join(bridgeHome, 'current.json'), { force: true });
    return { id, email: selected.email, label: selected.label };
  }
  function rename(id, label) {
    const rows = load(),
      row = rows.find((a) => a.id === id);
    if (!row) throw Error('账号不存在');
    row.label = String(label).trim() || row.email || 'ChatGPT 账号';
    writeJson(indexFile, rows);
  }
  function remove(id) {
    writeJson(
      indexFile,
      load().filter((a) => a.id !== id),
    );
    fs.rmSync(authFile(id), { force: true });
  }
  // 登录与额度查询使用各自的官方 app-server，不依赖桌面窗口是否已安装。
  // 每个账号有独立 CODEX_HOME，查询其他账号时不修改当前客户端的配置。
  function openSession(home, onNotification = () => {}) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      'cli_auth_credentials_store = "file"\n[features]\nplugins = false\nremote_plugin = false\n[analytics]\nenabled = false\n',
    );
    const env = require('./platform.cjs').codexEnv(home);
    for (const k of Object.keys(env))
      if (k.startsWith('CODEX_') && k !== 'CODEX_HOME') delete env[k];
    const executable =
      typeof codexExe === 'function' ? codexExe() : codexExe || findCodex({ dataHome: bridgeHome });
    const child = spawnProcess(executable, ['app-server'], {
      cwd: home,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pending = new Map(),
      exited = new Promise((resolve) => child.once('close', resolve));
    let seq = 0,
      buffer = '',
      closed = false;
    let processError;
    const fail = (error) => {
      if (error) processError = error;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(processError || Error('Codex 登录服务已结束，请检查程序路径与执行权限。'));
      }
      pending.clear();
    };
    const close = () => {
      if (!closed) {
        closed = true;
        fail();
        child.stdin.end();
        child.kill();
        const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
        timer.unref();
        exited.then(() => clearTimeout(timer));
      }
      return exited;
    };
    const rpc = (method, params) =>
      new Promise((resolve, reject) => {
        if (processError) {
          reject(processError);
          return;
        }
        const id = ++seq,
          timer = setTimeout(
            () => {
              pending.delete(id);
              reject(
                Object.assign(Error('Codex 服务响应超时，请检查网络后重试。'), { code: 'TIMEOUT' }),
              );
            },
            method === 'initialize' ? 10000 : 30000,
          );
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          clearTimeout(p.timer);
          msg.error
            ? p.reject(
                Object.assign(Error('官方服务请求失败（' + (msg.error.code || '未知') + '）。'), {
                  code: msg.error.code,
                  reason: classifyError(msg.error.message),
                }),
              )
            : p.resolve(msg.result);
        } else if (msg.method) onNotification(msg);
      }
    });
    child.stdin.on('error', () => fail());
    child.on('error', (e) =>
      fail(
        Object.assign(Error('无法启动 Codex 程序，请检查程序路径与执行权限。'), { code: e.code }),
      ),
    );
    child.on('exit', () => {
      fail();
      if (!closed) onNotification({ method: 'process/exit' });
    });
    const ready = async () => {
      await rpc('initialize', {
        clientInfo: { name: 'codex-api-switcher', title: 'Codex API 切换器', version: '1.0.0' },
      });
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    };
    return { rpc, ready, close };
  }
  // 只合并同一账号的重复请求。慢账号不能阻塞其他账号或占用全局切换锁。
  function quota(id) {
    if (quotaTasks.has(id)) return quotaTasks.get(id);
    const task = readQuota(id).finally(() => quotaTasks.delete(id));
    quotaTasks.set(id, task);
    return task;
  }
  async function readQuota(id) {
    captureCurrent();
    if (!load().some((a) => a.id === id)) throw Error('账号不存在，请重新选择');
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
    } catch (e) {
      const value = {
        ...previous,
        status: 'error',
        attemptedAt: new Date().toISOString(),
        error: quotaError(e),
      };
      writeJson(file, value);
      return { id, ...value };
    } finally {
      await check?.close();
    }
  }
  async function prepare(id) {
    captureCurrent();
    const row = load().find((a) => a.id === id);
    if (!row) throw Error('账号不存在，请重新选择');
    const auth = readJson(authFile(id)),
      live = identity(currentAuth());
    if (!identity(auth)) throw Error('登录记录不完整，请重新登录 ' + row.label);
    if (live?.id === id && !row.pendingLogin) {
      const exp = claims(auth.tokens.access_token).exp;
      // 访问令牌过期时仍可能通过刷新令牌恢复；由官方服务确认，不能仅凭 exp 要求重新登录。
      if (!exp || exp * 1000 > Date.now()) return row;
    }
    const check = openSession(path.dirname(authFile(id)));
    try {
      await check.ready();
      const result = await check.rpc('account/read', { refreshToken: true });
      if (result.account?.type !== 'chatgpt') throw Error('未读到 ChatGPT 登录');
      const refreshed = readJson(authFile(id));
      if (identity(refreshed)?.id !== id) throw Error('返回的账号与所选账号不一致');
      return remember(refreshed, { pendingLogin: row.pendingLogin });
    } catch (error) {
      const invalid = error.reason === 'auth' || [401, 'AUTH_REQUIRED'].includes(error.code);
      throw Error(
        invalid
          ? row.label + ' 的官方登录已失效，请点“重新登录”；本次未关闭桌面端。'
          : '无法准备 ' +
              row.label +
              ' 的官方登录，请检查网络后重试；尚未确认登录失效，本次未关闭桌面端。',
      );
    } finally {
      await check.close();
    }
  }
  async function finishLogin(message) {
    const active = session;
    session = null;
    await active?.close();
    login = { ...login, ...message };
  }
  async function startLogin({ id } = {}) {
    if (['starting', 'waiting'].includes(login?.status)) throw Error('请先完成或取消当前登录');
    const target = id ? load().find((a) => a.id === id) : null;
    if (id && !target) throw Error('账号不存在');
    const home = path.join(root, 'login');
    fs.mkdirSync(home, { recursive: true });
    fs.rmSync(path.join(home, 'auth.json'), { force: true });
    login = { status: 'starting', targetId: id || null };
    // 程序查找或启动也可能失败，必须包含在 try 内，让登录状态恢复为可重试。
    let active;
    try {
      active = session = openSession(home, async (msg) => {
        if (session !== active) return;
        if (msg.method === 'process/exit') {
          finishLogin({ status: 'error', message: '登录已结束，请重新登录' });
          return;
        }
        if (msg.method !== 'account/login/completed') return;
        if (!msg.params.success) {
          finishLogin({ status: 'error', message: '登录未完成，请重试' });
          return;
        }
        try {
          const auth = readJson(path.join(home, 'auth.json')),
            info = identity(auth);
          if (!info) throw Error('登录成功但未读到官方账号，请重试');
          if (id && info.id !== id)
            throw Error('登录的是其他账号或工作区，原账号未替换，请重新选择正确账号');
          const pendingLogin = identity(currentAuth())?.id === info.id;
          const row = remember(auth, { pendingLogin });
          fs.rmSync(path.join(home, 'auth.json'), { force: true });
          await finishLogin({
            status: 'done',
            accountId: row.id,
            message: (id ? '已更新 ' : '已添加 ') + row.label + '；在上方选择此账号并应用后使用。',
          });
        } catch (e) {
          fs.rmSync(path.join(home, 'auth.json'), { force: true });
          finishLogin({ status: 'error', message: e.message });
        }
      });
      await active.ready();
      const result = await active.rpc('account/login/start', {
        type: 'chatgpt',
        appBrand: 'chatgpt',
      });
      login = {
        ...login,
        status: 'waiting',
        loginId: result.loginId,
        authUrl: result.authUrl,
        message: id
          ? '请在官方页面重新登录 ' + target.label + '，完成后会更新原账号。'
          : '请在官方页面登录要添加的账号，完成后会自动加入列表。',
      };
      return { ...login };
    } catch (e) {
      await finishLogin({ status: 'error', message: e.message });
      throw e;
    }
  }
  async function cancelLogin() {
    const active = session;
    session = null;
    try {
      if (active && login?.loginId)
        await active.rpc('account/login/cancel', { loginId: login.loginId });
    } finally {
      await active?.close();
      login = { ...login, status: 'cancelled', message: '已取消登录' };
    }
  }
  return {
    status,
    syncCurrent,
    captureCurrent,
    apply,
    prepare,
    rename,
    remove,
    startLogin,
    cancelLogin,
    quota,
  };
}
function classifyError(message = '') {
  // 刷新请求的网络错误不等于凭证失效，不能只看到 refresh token 就要求用户重登。
  if (/network|connect|dns|timed? ?out|proxy|transport|send.*request/i.test(message))
    return 'network';
  return /401|unauthoriz|invalid.grant|token.{0,80}(?:expired|invalid|revoked|reused|already been used)|not authenticated|login required/i.test(
    message,
  )
    ? 'auth'
    : null;
}
function quotaError(e) {
  if (e.code === -32601) return '当前 Codex 版本不支持额度查询，请更新官方扩展或桌面版。';
  if (['CODEX_NOT_FOUND', 'ENOENT', 'EACCES', 'TIMEOUT', 'AUTH_REQUIRED'].includes(e.code))
    return e.message;
  if (e.reason === 'auth') return '此账号登录已失效，请点此账号的“重新登录”。';
  if (e.reason === 'network') return '无法连接官方额度服务，请检查网络或代理后重试。';
  return (
    '额度查询失败' + (e.code ? '（' + e.code + '）' : '') + '，请稍后重试；可尝试重新登录此账号。'
  );
}
module.exports = { createAccounts, identity, readJson, writeJson, quotaBuckets };
