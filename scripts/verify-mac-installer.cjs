'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const assert = require('node:assert/strict');

// 使用系统 Bash 和真实解压包执行安装，覆盖旧检查没有经过的 Install.command。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-installer-'));
const report = { platform: process.platform, arch: process.arch };
const reportFile = path.resolve('verification', 'macos-installer.json');
const run = (exe, args, options = {}) =>
  cp.execFileSync(exe, args, {
    encoding: 'utf8',
    timeout: 30000,
    ...options,
  });
const inspect = (exe, args) => {
  const result = cp.spawnSync(exe, args, { encoding: 'utf8', timeout: 30000 });
  return { status: result.status, output: (result.stdout || '') + (result.stderr || '') };
};

(async () => {
  try {
    assert.equal(process.platform, 'darwin');
    report.bash = run('/bin/bash', ['--version']).split('\n')[0];
    const oldInstaller = run('git', ['show', 'v0.1:install-mac.command']);
    run('/usr/bin/ditto', [
      '-xk',
      path.resolve(
        'dist',
        fs.existsSync(path.resolve('dist', `codex-switcher-macos-${process.arch}.zip`))
          ? `codex-switcher-macos-${process.arch}.zip`
          : 'codex-switcher-macos-universal.zip',
      ),
      root,
    ]);
    const installer = path.join(root, 'Install.command');
    run('/bin/bash', ['-n', installer]);
    const home = path.join(root, 'home with spaces');
    const data = path.join(home, 'Library', 'Application Support', 'CodexApiSwitcher');
    fs.mkdirSync(data, { recursive: true });
    // 有旧运行记录时也必须走通架构选择分支；使用不存在的进程，不触碰本机服务。
    fs.writeFileSync(path.join(data, 'running.json'), JSON.stringify({ pid: 2147483647 }));
    fs.writeFileSync(path.join(data, 'keep.txt'), 'account-data-marker');
    const env = { ...process.env, HOME: home };
    // -n 不执行命令替换，无法复现旧写法；实际运行旧记录分支才能触发截图中的错误。
    // 只替换最后的打开动作，防止旧脚本意外启动未隔离的桌面服务。
    const legacy = path.join(root, 'Install-previous.command');
    fs.writeFileSync(
      legacy,
      oldInstaller.replace('/usr/bin/open "$TARGET"', 'echo "Reached application open"'),
    );
    const oldResult = cp.spawnSync('/bin/bash', [legacy], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    report.previousInstaller = { status: oldResult.status, error: oldResult.stderr };
    assert.notEqual(oldResult.status, 0, '旧脚本必须复现已有运行记录时的安装错误');
    assert.match(oldResult.stderr, /command substitution.*line|syntax error/s);
    run('/bin/bash', [installer, '--no-open'], { env });
    run('/bin/bash', [installer, '--no-open'], { env });
    const app = path.join(home, 'Applications', 'Codex Switcher.app');
    assert.ok(fs.existsSync(path.join(app, 'Contents', 'MacOS', 'CodexSwitcher')));
    assert.equal(fs.readFileSync(path.join(data, 'keep.txt'), 'utf8'), 'account-data-marker');
    report.signature = inspect('/usr/bin/codesign', [
      '--verify',
      '--deep',
      '--strict',
      '--verbose=4',
      app,
    ]);
    assert.equal(report.signature.status, 0, '安装后应用的完整签名必须有效');
    const mainExecutable = run('/usr/bin/file', [
      path.join(app, 'Contents', 'MacOS', 'CodexSwitcher'),
    ]);
    assert.match(mainExecutable, /Mach-O universal binary/);
    report.assessment = inspect('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vv', app]);
    report.passed = true;
    report.checks = [
      'system-bash-syntax',
      'first-install',
      'repeat-install',
      'existing-running-record',
      'data-preserved',
      'valid-bundle-signature',
      'native-universal-launcher',
    ];
  } catch (error) {
    report.passed = false;
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    report.checkedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    await fs.promises.rm(root, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report));
})();
