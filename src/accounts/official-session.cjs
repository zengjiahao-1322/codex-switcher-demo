'use strict';

const { spawn } = require('node:child_process');
const { findCodex } = require('../platform/runtime.cjs');

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

// 业务层使用固定类型判断，错误文案只用于显示。
function officialErrorKind(error) {
  if (error.code === 'AUTH_REQUIRED' || error.code === 401 || error.reason === 'auth')
    return 'auth_invalid';
  if (error.code === 'TIMEOUT' || error.reason === 'network') return 'network_error';
  if ([-32601, 'CODEX_NOT_FOUND', 'ENOENT', 'EACCES'].includes(error.code)) return 'runtime_error';
  return 'service_error';
}

function createOfficialSession({ bridgeHome, codexExe, spawnProcess = spawn }) {
  // 每个账号使用自己的 CODEX_HOME；调用方决定何时关闭进程。
  return function openSession(home, onNotification = () => {}) {
    const fs = require('node:fs'),
      path = require('node:path');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      'cli_auth_credentials_store = "file"\n[features]\nplugins = false\nremote_plugin = false\n[analytics]\nenabled = false\n',
    );
    const env = require('../platform/platform.cjs').codexEnv(home);
    for (const key of Object.keys(env))
      if (key.startsWith('CODEX_') && key !== 'CODEX_HOME') delete env[key];
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
    let sequence = 0,
      buffer = '',
      closed = false,
      processError;
    const fail = (error) => {
      if (error) processError = error;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(processError || Error('Codex 登录服务已结束，请检查程序路径与执行权限。'));
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
        const id = ++sequence,
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
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const request = pending.get(message.id);
        if (request) {
          pending.delete(message.id);
          clearTimeout(request.timer);
          message.error
            ? request.reject(
                Object.assign(
                  Error('官方服务请求失败（' + (message.error.code || '未知') + '）。'),
                  {
                    code: message.error.code,
                    reason: classifyError(message.error.message),
                  },
                ),
              )
            : request.resolve(message.result);
        } else if (message.method) onNotification(message);
      }
    });
    child.stdin.on('error', () => fail());
    child.on('error', (error) =>
      fail(
        Object.assign(Error('无法启动 Codex 程序，请检查程序路径与执行权限。'), {
          code: error.code,
        }),
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
  };
}

module.exports = { createOfficialSession, officialErrorKind };
