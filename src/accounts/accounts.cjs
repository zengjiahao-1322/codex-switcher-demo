'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { switchJob } = require('../config/switch-state.cjs'),
  { createOfficialSession, officialErrorKind } = require('./official-session.cjs'),
  { createQuotaReader, quotaBuckets } = require('./quota-reader.cjs');
const { log } = require('../diagnostics/event-log.cjs');
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
    subscription = id['https://api.openai.com/auth'] || {},
    a = access['https://api.openai.com/auth'] || subscription;
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
    // 订阅日期位于 ID 令牌，访问令牌的套餐声明不包含这些字段。
    subscriptionUntil: subscription.chatgpt_subscription_active_until || null,
    subscriptionCheckedAt: subscription.chatgpt_subscription_last_checked || null,
  };
}
function createAccounts({ codexHome, bridgeHome, codexExe, spawnProcess }) {
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
    const saved = old && readJson(authFile(info.id));
    if (saved && Date.parse(saved.last_refresh) > Date.parse(auth.last_refresh)) return old;
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
      items: load().map((row) => {
        const auth = readJson(authFile(row.id)),
          latest = identity(auth);
        return {
          ...row,
          plan: latest?.plan || 'unknown',
          subscriptionUntil: latest?.subscriptionUntil || null,
          subscriptionCheckedAt: latest?.subscriptionCheckedAt || null,
          refreshedAt: auth?.last_refresh || null,
          current: row.id === current?.id,
          quota: readJson(path.join(root, row.id, 'quota.json')),
        };
      }),
      credentialsNotice,
      login: login ? { ...login } : null,
      switchJob: switchJob(bridgeHome),
    };
  }
  // 仅供后台互通模块使用；这些方法不作为HTTP动作，不向网页返回登录正文。
  function getAuth(id) {
    if (!load().some((row) => row.id === id)) throw Error('账号不存在，请重新选择');
    return readJson(authFile(id));
  }
  function mergeAuth(auth) {
    const info = identity(auth),
      saved = getAuth(info.id);
    if ((Date.parse(auth.last_refresh) || 0) <= (Date.parse(saved?.last_refresh) || 0))
      return false;
    remember(auth);
    return true;
  }
  function syncLocalAuth(auth) {
    const live = currentAuth();
    if (identity(live)?.id !== identity(auth).id) return false;
    let mode;
    try {
      mode = require('smol-toml').parse(
        fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'),
      ).cli_auth_credentials_store;
    } catch (error) {
      if (error.code !== 'ENOENT') throw Error('本机配置无法解析，未同步登录');
    }
    if (['keyring', 'ephemeral'].includes(mode) || (keychainMode && keychainAuth)) return false;
    if ((Date.parse(auth.last_refresh) || 0) <= (Date.parse(live?.last_refresh) || 0)) return false;
    writeJson(liveFile, auth);
    return true;
  }
  function apply(id, model, catalog) {
    const selected = load().find((a) => a.id === id);
    if (!selected) throw Error('请选择一个已保存的官方账号');
    captureCurrent();
    const auth = readJson(authFile(id));
    require('../config/core.cjs').applyOfficial(codexHome, model, catalog, 'file');
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
  const openSession = createOfficialSession({ bridgeHome, codexExe, spawnProcess }),
    { quota } = createQuotaReader({
      bridgeHome,
      root,
      load,
      authFile,
      captureCurrent,
      currentId: () => identity(currentAuth())?.id,
      openSession,
      readJson,
      writeJson,
    });
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
    let check;
    try {
      check = openSession(path.dirname(authFile(id)));
      await check.ready();
      const result = await check.rpc('account/read', { refreshToken: true });
      if (result.account?.type !== 'chatgpt')
        throw Object.assign(Error('未读到 ChatGPT 登录'), { code: 'AUTH_REQUIRED' });
      const refreshed = readJson(authFile(id));
      if (identity(refreshed)?.id !== id) throw Error('返回的账号与所选账号不一致');
      return remember(refreshed, { pendingLogin: row.pendingLogin });
    } catch (error) {
      const kind = officialErrorKind(error);
      log(bridgeHome, 'official.error', {
        op: 'prepare',
        account: row.email,
        kind,
        code: error.code ?? null,
        message: error.message,
      });
      const failure = Error(
        kind === 'auth_invalid'
          ? row.label + ' 的官方登录已失效，请点“重新登录”；本次未关闭桌面端。'
          : kind === 'network_error'
            ? '无法准备 ' +
              row.label +
              ' 的官方登录，请检查网络后重试；尚未确认登录失效，本次未关闭桌面端。'
            : kind === 'runtime_error'
              ? '官方登录校验程序不可用：' + error.message + '；本次未关闭桌面端。'
              : '官方登录校验未完成；尚未确认登录失效，本次未关闭桌面端。',
      );
      failure.kind = kind;
      throw failure;
    } finally {
      await check?.close();
    }
  }
  async function finishLogin(active, attempt, message, error) {
    // 先提交终态，再回收进程；旧进程的退出通知不能覆盖成功或下一次登录。
    if (session !== active || login !== attempt) return;
    session = null;
    Object.assign(attempt, message);
    if (message.status === 'error')
      log(bridgeHome, 'official.error', {
        op: 'login',
        account: load().find((a) => a.id === attempt.targetId)?.email || null,
        kind: officialErrorKind(error || Error(message.message)),
        code: error?.code ?? null,
        message: error?.message || message.message,
      });
    await active?.close();
  }
  async function startLogin({ id } = {}) {
    if (['starting', 'waiting'].includes(login?.status)) throw Error('请先完成或取消当前登录');
    const target = id ? load().find((a) => a.id === id) : null;
    if (id && !target) throw Error('账号不存在');
    // 每次登录拥有独立目录，迟到的浏览器回调不会写进下一次登录的凭证文件。
    const home = path.join(root, 'login', crypto.randomUUID());
    fs.mkdirSync(home, { recursive: true });
    const attempt = { status: 'starting', targetId: id || null };
    login = attempt;
    // 程序查找或启动也可能失败，必须包含在 try 内，让登录状态恢复为可重试。
    let active = null,
      started = false,
      completing = false;
    const notifications = [];
    const onNotification = async (msg) => {
      if (session !== active || login !== attempt || completing) return;
      if (!started) {
        notifications.push(msg);
        return;
      }
      if (msg.method === 'process/exit') {
        completing = true;
        await finishLogin(active, attempt, {
          status: 'error',
          message: '登录进程已结束，未收到本次登录成功通知；请重试。',
        });
        return;
      }
      if (msg.method !== 'account/login/completed') return;
      // 同一进程可能发出旧尝试的取消/完成通知，只处理本次 loginId。
      if (msg.params.loginId !== attempt.loginId) return;
      completing = true;
      if (!msg.params.success) {
        // 保留可读原因，不把授权码、URL 或 token 输出到界面。
        const reason = String(msg.params.error || '官方未返回具体原因')
          .replace(/https?:\/\/\S+/gi, '[登录地址已隐藏]')
          .replace(/eyJ[A-Za-z0-9_.-]+/g, '[凭证已隐藏]')
          .replace(/((?:code|state|token|secret)\s*[=:]\s*)[^\s,}]+/gi, '$1[已隐藏]')
          .slice(0, 240);
        await finishLogin(active, attempt, {
          status: 'error',
          message: '官方登录未完成：' + reason + '。若网页已成功，请保留登录目录以便恢复。',
        });
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
        await finishLogin(active, attempt, {
          status: 'done',
          accountId: row.id,
          message: (id ? '已更新 ' : '已添加 ') + row.label + '；在上方选择此账号并应用后使用。',
        });
      } catch (error) {
        // 保存失败时保留已经取得的凭证，不能让一次入库错误迫使用户重新登录。
        await finishLogin(active, attempt, { status: 'error', message: error.message }, error);
      }
    };
    try {
      active = session = openSession(home, onNotification);
      await active.ready();
      const result = await active.rpc('account/login/start', {
        type: 'chatgpt',
        appBrand: 'chatgpt',
      });
      Object.assign(attempt, {
        status: 'waiting',
        loginId: result.loginId,
        authUrl: result.authUrl,
        message: id
          ? '请在官方页面重新登录 ' + target.label + '，完成后会更新原账号。'
          : '请在官方页面登录要添加的账号，完成后会自动加入列表。',
      });
      started = true;
      // 完成通知可能与 start 响应落在同一段 stdout，等拿到 loginId 后再处理。
      for (const notification of notifications) await onNotification(notification);
      return { ...attempt };
    } catch (e) {
      await finishLogin(active, attempt, { status: 'error', message: e.message }, e);
      throw e;
    }
  }
  async function cancelLogin() {
    const active = session,
      attempt = login;
    session = null;
    if (attempt) Object.assign(attempt, { status: 'cancelled', message: '已取消登录' });
    try {
      if (active && login?.loginId)
        await active.rpc('account/login/cancel', { loginId: login.loginId });
    } finally {
      await active?.close();
    }
  }
  return {
    status,
    syncCurrent,
    captureCurrent,
    getAuth,
    mergeAuth,
    syncLocalAuth,
    apply,
    prepare,
    rename,
    remove,
    startLogin,
    cancelLogin,
    quota,
  };
}
module.exports = { createAccounts, identity, readJson, writeJson, quotaBuckets };
