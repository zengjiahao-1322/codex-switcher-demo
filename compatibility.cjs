const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  { spawn } = require('node:child_process'),
  { findCodex } = require('./runtime.cjs'),
  toml = require('smol-toml');
// 用本机 Codex 在隔离 CODEX_HOME 中校验即将写入的配置（脱敏：密钥与地址换成占位值）。
// 有 model_catalog_json 时再调用 model/list，确认 Codex 实际采用了该模型目录（目录无效时 Codex 会静默退回官方列表）。
async function validateConfig(text, codexExe) {
  let parsed;
  try {
    parsed = toml.parse(text);
  } catch {
    return { ok: false, message: '生成的 TOML 无法解析；没有修改配置。' };
  }
  const subset = {
    model: parsed.model,
    model_provider: parsed.model_provider,
    model_catalog_json: parsed.model_catalog_json,
    model_providers: parsed.model_providers,
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-validate-'));
  try {
    const secretFree = JSON.parse(JSON.stringify(subset));
    for (const p of Object.values(secretFree.model_providers || {})) {
      delete p.env_key;
      delete p.http_headers;
      delete p.env_http_headers;
      p.experimental_bearer_token = 'validation-not-a-real-key';
      p.base_url = 'http://127.0.0.1:1/v1';
    }
    fs.writeFileSync(path.join(home, 'config.toml'), toml.stringify(secretFree));
    return await new Promise((resolve) => {
      const p = spawn(codexExe || findCodex(), ['--strict-config', 'app-server'], {
        cwd: home,
        env: require('./platform.cjs').codexEnv(home),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let buf = '',
        done = false;
      const finish = (ok, message) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const result = {
          ok,
          message:
            message ||
            (ok ? '当前 Codex 配置解析通过' : '当前 Codex 拒绝供应商配置；未修改原配置。'),
        };
        p.once('close', () => resolve(result));
        p.stdin.end();
        p.kill();
      };
      const timer = setTimeout(() => finish(false), 20000);
      p.on('error', () => finish(false));
      p.on('exit', () => finish(false));
      p.stderr.resume();
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (x) => {
        buf += x;
        let n;
        while ((n = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, n);
          buf = buf.slice(n + 1);
          let j;
          try {
            j = JSON.parse(line);
          } catch {
            continue;
          }
          if (j.id === 1) {
            if (!j.result || j.error) return finish(false);
            if (!subset.model_catalog_json) return finish(true);
            p.stdin.write(JSON.stringify({ id: 2, method: 'model/list', params: {} }) + '\n');
          } else if (j.id === 2) {
            const ok =
              Array.isArray(j.result?.data) && j.result.data.some((m) => m.model === subset.model);
            finish(ok, ok ? undefined : 'Codex 未能采用生成的模型目录；未修改原配置。');
          }
        }
      });
      p.stdin.write(
        JSON.stringify({
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'bridge-config-check', version: '1' } },
        }) + '\n',
      );
    });
  } finally {
    await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
module.exports = { validateConfig };
