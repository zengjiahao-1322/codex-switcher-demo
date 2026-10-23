'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  cp = require('node:child_process');
const REPOSITORY = 'zengjiahao-1322/codex-switcher-demo',
  RELEASE_TAG = 'v0.1.3';

function assetName() {
  if (process.platform === 'win32') return 'codex-switcher-windows-x64.zip';
  if (process.platform === 'darwin')
    return process.arch === 'arm64'
      ? 'codex-switcher-macos-arm64.zip'
      : 'codex-switcher-macos-x64.zip';
  throw Error('当前平台不支持一键升级');
}

function createUpdateManager({ bridgeHome, projectDir, build, version, fetchImpl = fetch }) {
  const state = {
    current: { version, build },
    latest: null,
    checkedAt: null,
    status: 'idle',
  };
  const metadataUrl = `https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}/release.json`;
  let task = null;
  let metadata = null;
  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }
  async function checkUpdate() {
    if (state.checkedAt && Date.now() - Date.parse(state.checkedAt) < 6 * 60 * 60 * 1000)
      return snapshot();
    state.status = 'checking';
    try {
      const response = await fetchImpl(metadataUrl, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw Error('更新信息请求失败（HTTP ' + response.status + '）');
      const latest = await response.json();
      metadata = latest;
      state.latest = {
        version: latest.version,
        build: latest.build,
        publishedAt: latest.publishedAt,
        notes: latest.notes,
      };
      state.checkedAt = new Date().toISOString();
      state.status = latest.build && latest.build !== build ? 'available' : 'idle';
    } catch (error) {
      state.status = 'error';
      state.error = error.message;
    }
    return snapshot();
  }
  async function installUpdate() {
    if (task) return task;
    task = (async () => {
      if (fs.existsSync(path.join(projectDir, '.git'))) throw Error('开发目录请用 git 更新。');
      const current = state.latest || (await checkUpdate()).latest;
      if (!current || current.build === build) throw Error('当前已经是最新构建。');
      state.status = 'downloading';
      state.progress = 0;
      // 安装进程实现替换与回滚；当前进程只下载并校验，避免覆盖正在运行的文件。
      const name = assetName(),
        digest = metadata?.assets?.[name],
        url = `https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}/${name}`;
      if (!digest) throw Error('更新信息缺少当前平台校验值。');
      const updates = path.join(bridgeHome, 'updates'),
        staging = path.join(updates, 'staging');
      fs.mkdirSync(staging, { recursive: true });
      const archive = path.join(staging, name),
        response = await fetchImpl(url, { signal: AbortSignal.timeout(240000) });
      if (!response.ok) throw Error('更新下载失败（HTTP ' + response.status + '）');
      fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
      const actual = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
      if (actual !== digest) throw Error('更新校验和不匹配，未修改任何文件。');
      state.status = 'installing';
      state.progress = 50;
      const worker = path.join(projectDir, 'scripts', 'update-worker.cjs');
      cp.spawn(
        process.execPath,
        [worker, '--pid', String(process.pid), '--archive', archive, '--target', projectDir],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        },
      ).unref();
      return { message: '更新已下载并开始安装；后台会在替换后自动重启。' };
    })()
      .catch((error) => {
        state.status = 'error';
        state.error = error.message;
        throw error;
      })
      .finally(() => {
        task = null;
      });
    return task;
  }
  return {
    state: snapshot,
    actions: { checkUpdate, installUpdate },
  };
}

module.exports = { createUpdateManager, assetName, RELEASE_TAG, REPOSITORY };
