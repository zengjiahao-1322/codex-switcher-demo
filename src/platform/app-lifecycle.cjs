'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process');
const { log } = require('../diagnostics/event-log.cjs');
function otherInstallAction(oldSequence, currentSequence) {
  return Number(oldSequence || 0) >= Number(currentSequence || 0) ? 'deferred' : 'stopped';
}
function integrateDesktop(projectDir, discoveryDir, bridgeHome, { execute = cp.execFile } = {}) {
  return new Promise((resolve, reject) => {
    execute(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(projectDir, 'platform/windows/desktop-integration.ps1'),
        '-InstallDir',
        projectDir,
        '-DiscoveryDir',
        discoveryDir,
      ],
      { windowsHide: true, encoding: 'utf8' },
      (error, output) => {
        if (error) return reject(error);
        try {
          const result = JSON.parse(output.replace(/^\uFEFF/, '').trim());
          if (result.shortcutChanged) log(bridgeHome, 'app.shortcuts', {});
          resolve(result);
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}
function createLifecycle({
  projectDir,
  bridgeHome,
  codexHome,
  discoveryDir,
  shutdown,
  platform = process.platform,
  spawn = cp.spawn,
}) {
  const core = require('../config/core.cjs'),
    operation = require('../config/switch-state.cjs');
  const check = () => {
    if (operation.activeJob(operation.switchJob(bridgeHome)))
      throw Error('切换任务正在进行，请等它完成后再退出或卸载。');
  };
  const finish = (after) =>
    setTimeout(() => {
      for (const file of [
        path.join(bridgeHome, 'running.json'),
        discoveryDir && path.join(discoveryDir, 'connection.json'),
      ].filter(Boolean)) {
        if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file)).pid === process.pid)
          fs.rmSync(file);
      }
      after?.();
      shutdown();
    }, 200);
  function quit() {
    check();
    log(bridgeHome, 'app.quit', {});
    finish();
    return { message: '切换器已退出' };
  }
  function uninstall({ keepData = true } = {}) {
    check();
    if (fs.existsSync(path.join(projectDir, '.git')))
      throw Error('开发目录请保留源码，不能从这里卸载。');
    const configFile = path.join(codexHome, 'config.toml'),
      config = fs.existsSync(configFile)
        ? require('smol-toml').parse(fs.readFileSync(configFile, 'utf8'))
        : {},
      adapterFile = path.join(bridgeHome, 'adapter.json'),
      adapter = fs.existsSync(adapterFile) ? JSON.parse(fs.readFileSync(adapterFile)) : {},
      provider = config.model_providers?.[config.model_provider],
      restored = provider?.base_url === 'http://127.0.0.1:' + adapter.port + '/v1';
    if (restored) core.restoreOfficial(codexHome, bridgeHome);
    log(bridgeHome, 'app.uninstall', { keepData, restoredOfficial: restored });
    const args =
      platform === 'win32'
        ? [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            path.join(projectDir, 'uninstall.ps1'),
            '-KeepCodexConfig',
            ...(keepData ? ['-KeepData'] : []),
          ]
        : [
            path.join(projectDir, 'platform/macos/uninstall-mac.sh'),
            projectDir,
            bridgeHome,
            String(keepData),
            String(process.pid),
          ];
    finish(() => {
      const child = spawn(platform === 'win32' ? 'powershell.exe' : '/bin/bash', args, {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          BRIDGE_HOME: bridgeHome,
          BRIDGE_CODEX_HOME: codexHome,
          BRIDGE_UNINSTALL_PID: String(process.pid),
        },
      });
      child.unref();
    });
    return { message: '正在卸载，完成后可关闭本页。' };
  }
  return { quit, uninstall };
}
module.exports = { integrateDesktop, createLifecycle, otherInstallAction };
