'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  cp = require('node:child_process');
const { log } = require('../diagnostics/event-log.cjs');
const REPOSITORY = 'zengjiahao-1322/codex-switcher-demo';
const releaseUrl = `https://github.com/${REPOSITORY}/releases/latest/download/`;
function withProxyHint(message, error, proxy) {
  if (proxy?.type !== 'manual') return message;
  if (error?.curl?.code === 7) return `连不上系统代理 ${proxy.value}，请确认代理软件在运行。`;
  return `${message}（经系统代理 ${proxy.value}）`;
}

function assetName(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'codex-switcher-windows-x64.zip';
  if (platform === 'darwin') return `codex-switcher-macos-${arch}.zip`;
  throw Error('当前平台不支持一键升级。');
}
// 系统 curl 使用与官方会话相同的代理环境，不增加网络依赖。
function transportFor(
  codexHome,
  { platform = process.platform, execute = require('node:util').promisify(cp.execFile) } = {},
) {
  const request = async (url, output) => {
    const env = require('../platform/platform.cjs').codexEnv(codexHome);
    const args = [
      '--fail',
      '--location',
      '--silent',
      '--show-error',
      '--connect-timeout',
      '15',
      '--max-time',
      '240',
    ];
    // Schannel可访问吊销服务器时仍检查；仅忽略其离线状态，保留证书链和主机名验证。
    if (platform === 'win32') args.push('--ssl-revoke-best-effort');
    if (output) args.push('--output', output);
    args.push(url);
    try {
      const { stdout } = await execute(platform === 'win32' ? 'curl.exe' : '/usr/bin/curl', args, {
        env,
        encoding: null,
        windowsHide: true,
        timeout: 250000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      // Windows stderr可能是GBK；不把execFile附带的整条命令或乱码交给页面。
      const detail = (error.stderr?.toString('latin1').match(/[\x20-\x7e]{5,}/g) || [])
          .filter((text) =>
            /curl:|schannel|CRYPT_|SSL|TLS|certificate|connect|resolve|timed out/i.test(text),
          )
          .join(' ')
          .slice(0, 800),
        code = error.code ?? null;
      const message = /CRYPT_E_REVOCATION_OFFLINE/.test(detail)
        ? '连接 GitHub 失败：证书吊销检查无法完成（网络无法访问吊销服务器）。'
        : code === 28 || error.killed
          ? '连接 GitHub 超时，请检查网络或代理后重试。'
          : code === 60
            ? '连接 GitHub 失败：服务器证书验证未通过。'
            : '连接 GitHub 失败（curl 退出码 ' + code + '），请检查网络或代理。';
      throw Object.assign(Error(message), { curl: { code, detail } });
    }
  };
  return {
    readJson: async (url) => JSON.parse((await request(url)).toString('utf8')),
    download: request,
  };
}
function extractArchive(archive, destination, platform = process.platform) {
  fs.mkdirSync(destination, { recursive: true });
  return require('node:util').promisify(cp.execFile)(
    platform === 'win32' ? 'tar.exe' : '/usr/bin/ditto',
    platform === 'win32' ? ['-xf', archive, '-C', destination] : ['-x', '-k', archive, destination],
    { windowsHide: true, timeout: 120000 },
  );
}
function packageRoot(extracted, platform = process.platform) {
  return platform === 'win32'
    ? path.join(extracted, 'Codex Switcher')
    : path.join(extracted, 'Codex Switcher.app', 'Contents', 'Resources');
}
function validatePackage(root) {
  const files = JSON.parse(fs.readFileSync(path.join(root, 'release-files.json'), 'utf8'));
  for (const relative of files) {
    // 外部发行清单不能越出安装目录，也不能覆盖账号数据。
    if (
      typeof relative !== 'string' ||
      path.isAbsolute(relative) ||
      relative.split(/[\\/]/).includes('..') ||
      /^(?:private|\.git)(?:[\\/]|$)/i.test(relative)
    )
      throw Error('更新包包含无效文件路径。');
    if (!fs.statSync(path.join(root, relative)).isFile())
      throw Error('更新包缺少文件：' + relative);
  }
  for (const dir of ['runtime', 'bin', 'node_modules'])
    if (!fs.statSync(path.join(root, dir)).isDirectory()) throw Error('更新包缺少目录：' + dir);
  return files;
}
function startWorker(job) {
  const file = path.join(job.staging, 'job.json');
  fs.writeFileSync(file, JSON.stringify(job), { mode: 0o600 });
  const node =
    job.platform === 'win32'
      ? path.join(job.source, 'runtime', 'node.exe')
      : path.join(job.source, 'runtime', job.arch, 'node');
  return new Promise((resolve, reject) => {
    const child = cp.fork(path.join(job.source, 'scripts', 'update-worker.cjs'), [file], {
      execPath: node,
      cwd: job.staging,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(Error('升级进程未能启动。'));
    }, 10000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(Error('升级进程提前退出：' + code));
    });
    child.once('message', (message) => {
      clearTimeout(timer);
      if (!message.ready) return reject(Error('升级进程未确认就绪。'));
      child.unref();
      resolve();
    });
  });
}
function createUpdateManager({
  bridgeHome,
  codexHome,
  projectDir,
  build,
  version,
  sequence,
  platform = process.platform,
  arch = process.arch,
  transport = transportFor(codexHome),
  extract = extractArchive,
  launchWorker = startWorker,
  shutdown,
}) {
  const proxyInfo = () => require('../platform/platform.cjs').proxyInfo(codexHome);
  const resultFile = path.join(bridgeHome, 'updates', 'result.json');
  const previous = fs.existsSync(resultFile)
    ? JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    : null;
  const dev = fs.existsSync(path.join(projectDir, '.git'));
  const state = {
    current: { version, build, sequence: dev ? null : sequence },
    dev,
    latest: null,
    checkedAt: null,
    status: previous?.error ? 'error' : 'idle',
    ...(previous?.error ? { error: previous.error } : {}),
  };
  let metadata = null,
    checking = null,
    task = null;
  const snapshot = () => structuredClone(state);
  const newer = () =>
    !state.dev &&
    Number.isSafeInteger(state.current.sequence) &&
    state.current.sequence > 0 &&
    metadata.sequence > state.current.sequence;
  async function checkUpdate() {
    if (task) return snapshot();
    if (checking) return checking;
    if (state.checkedAt && Date.now() - Date.parse(state.checkedAt) < 6 * 60 * 60 * 1000)
      return snapshot();
    checking = (async () => {
      const started = performance.now(),
        proxy = proxyInfo();
      state.status = 'checking';
      try {
        const latest = await transport.readJson(releaseUrl + 'release.json');
        if (
          typeof latest.version !== 'string' ||
          !Number.isSafeInteger(latest.sequence) ||
          latest.sequence <= 0 ||
          !/^[a-f0-9]{12}$/.test(latest.build) ||
          !/^[a-f0-9]{40}$/.test(latest.commit) ||
          !Number.isFinite(Date.parse(latest.publishedAt)) ||
          typeof latest.notes !== 'string' ||
          !/^[a-f0-9]{64}$/.test(latest.assets?.[assetName(platform, arch)])
        )
          throw Error('发布元数据不完整，请稍后检查。');
        metadata = latest;
        state.latest = {
          version: latest.version,
          build: latest.build,
          sequence: latest.sequence,
          publishedAt: latest.publishedAt,
          notes: latest.notes,
        };
        state.checkedAt = new Date().toISOString();
        state.status = newer() ? 'available' : 'idle';
        delete state.error;
        log(bridgeHome, 'update.check', {
          build: latest.build,
          durationMs: Math.round(performance.now() - started),
          status: state.status,
          proxy,
        });
      } catch (error) {
        const message = withProxyHint(error.message, error, proxy);
        state.status = 'error';
        state.error = message;
        log(bridgeHome, 'update.check', {
          build,
          durationMs: Math.round(performance.now() - started),
          error: message,
          proxy,
          ...(error.curl ? { curl: error.curl } : {}),
        });
      }
      return snapshot();
    })().finally(() => {
      checking = null;
    });
    return checking;
  }
  async function installUpdate(input = {}) {
    if (Object.keys(input).length) throw Error('升级不接受地址或其他参数。');
    if (fs.existsSync(path.join(projectDir, '.git'))) throw Error('开发目录请用 git 更新。');
    if (platform === 'darwin') {
      const app = path.resolve(projectDir, '..', '..');
      if (!app.endsWith('.app') || app.includes('/AppTranslocation/'))
        throw Error('当前应用位置无法直接更新，请手动下载安装。');
      try {
        fs.accessSync(path.dirname(app), fs.constants.W_OK);
      } catch {
        throw Error('当前应用位置只读，请手动下载安装。');
      }
    }
    if (task) return { message: '更新正在进行。' };
    if (!metadata) await checkUpdate();
    if (!metadata) throw Error(state.error || '尚未取得更新信息。');
    if (!newer()) throw Error('不会安装相同或更旧的版本。');
    state.status = 'downloading';
    state.progress = 0;
    delete state.error;
    // 先回复网页，再执行下载；独立升级进程确认启动后才退出旧后台。
    task = new Promise((resolve) => setImmediate(resolve))
      .then(async () => {
        const started = performance.now(),
          proxy = proxyInfo(),
          name = assetName(platform, arch),
          stagingRoot = path.join(bridgeHome, 'updates', 'staging');
        fs.mkdirSync(stagingRoot, { recursive: true });
        const staging = fs.mkdtempSync(path.join(stagingRoot, 'package-')),
          archive = path.join(staging, name);
        try {
          await transport.download(releaseUrl + name, archive);
          const actual = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
          if (actual !== metadata.assets[name]) throw Error('更新校验和不匹配，未修改安装文件。');
          log(bridgeHome, 'update.download', {
            build: metadata.build,
            durationMs: Math.round(performance.now() - started),
            status: 'verified',
            proxy,
          });
          state.progress = 50;
          const extracted = path.join(staging, 'extracted');
          await extract(archive, extracted, platform);
          const source = packageRoot(extracted, platform);
          validatePackage(source);
          const packaged = require(
            path.join(source, 'src', 'platform', 'build-info.cjs'),
          ).buildInfo();
          if (packaged.id !== metadata.build) throw Error('更新包构建号与发布信息不一致。');
          if (packaged.sequence !== metadata.sequence)
            throw Error('更新包发行序号与发布信息不一致。');
          state.status = 'installing';
          state.progress = 75;
          await launchWorker({
            pid: process.pid,
            source,
            staging,
            target: projectDir,
            bridgeHome,
            codexHome,
            build: metadata.build,
            platform,
            arch,
          });
          shutdown();
        } catch (error) {
          const message = withProxyHint(error.message, error, proxy);
          log(bridgeHome, state.status === 'downloading' ? 'update.download' : 'update.install', {
            build: metadata.build,
            durationMs: Math.round(performance.now() - started),
            error: message,
            proxy,
            ...(error.curl ? { curl: error.curl } : {}),
          });
          throw Object.assign(error, { message });
        }
      })
      .catch((error) => {
        state.status = 'error';
        state.error = error.message;
      })
      .finally(() => {
        task = null;
      });
    return { message: '正在下载并校验更新，安装完成后会自动打开新页面。' };
  }
  return { state: snapshot, actions: { checkUpdate, installUpdate }, finished: () => task };
}
module.exports = {
  createUpdateManager,
  assetName,
  extractArchive,
  packageRoot,
  validatePackage,
  transportFor,
  REPOSITORY,
};
