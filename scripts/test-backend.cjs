'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { rustBinary } = require('../tests/backend.cjs');
const root = path.resolve(__dirname, '..');
const destination =
  process.env.SWITCHER_REPORT_DIR || path.join(root, '.build-cache', 'rust-parity');
fs.mkdirSync(destination, { recursive: true });
if (!fs.existsSync(rustBinary()))
  throw Error('Build Rust first: cargo build --locked --release --manifest-path rust/Cargo.toml');

const httpPatterns = {
  'blackbox-usage.test.cjs': '.*',
  'blackbox-usage-package.test.cjs': '.*',
  'blackbox-next-startup.test.cjs': '.*',
  'blackbox-claude-stream.test.cjs': '.*',
  'blackbox-batch6.test.cjs': '.*',
  'blackbox-adapter.test.cjs': '.*',
  'blackbox-process-fault.test.cjs': '.*',
  'blackbox-accounts.test.cjs': '.*',
  'blackbox-accounts-network.test.cjs': '.*',
  'blackbox-accounts-native.test.cjs': '.*',
  'blackbox-switching.test.cjs': '.*',
  'blackbox-editors.test.cjs': '.*',
  'blackbox-local-switch.test.cjs': '.*',
  'blackbox-remote.test.cjs': '.*',
  'blackbox-remote-expiry.test.cjs': '.*',
  'blackbox-window-algorithm.test.cjs': '.*',
  'blackbox-extension-install.test.cjs': '.*',
  'blackbox-threads-native.test.cjs': '.*',
  'blackbox-claude.test.cjs': '.*',
  'blackbox-framework.test.cjs': '.*',
  'blackbox-migration.test.cjs': '.*',
  'blackbox-diagnostics.test.cjs': '.*',
  'blackbox-platform.test.cjs': '.*',
  'blackbox-config.test.cjs': '.*',
  'blackbox-config-algorithm.test.cjs': '.*',
  'blackbox-config-matrix.test.cjs': '.*',
  'blackbox-config-backups.test.cjs': '.*',
  'blackbox-config-network.test.cjs': '.*',
  'startup-log.test.cjs': '.*',
  'long-poll.test.cjs': '^(不带 wait|带 wait=|挂起期间另一进程)',
};
const report = { backend: 'rust', generatedAt: new Date().toISOString(), files: [] };
for (const [file, pattern] of Object.entries(httpPatterns)) {
  const run = spawnSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      '--test',
      '--test-timeout=180000',
      '--test-reporter=tap',
      '--test-name-pattern=' + pattern,
      path.join(root, 'tests', file),
    ],
    { cwd: root, env: process.env, encoding: 'utf8', timeout: 180000, windowsHide: true },
  );
  const output = (run.stdout || '') + (run.stderr || '');
  fs.writeFileSync(path.join(destination, file + '.tap'), output);
  if (run.status !== 0) process.stdout.write(output);
  const row = {
    file,
    pass: Number(output.match(/^# pass (\d+)$/m)?.[1] || 0),
    fail:
      Number(output.match(/^# fail (\d+)$/m)?.[1] || 0) +
      Number(output.match(/^# cancelled (\d+)$/m)?.[1] || 0),
    exitCode: run.status,
    runnerError: run.error?.message || null,
  };
  if (run.status !== 0 && row.fail === 0) row.fail = 1;
  report.files.push(row);
  console.log(file + ': pass=' + row.pass + ', fail=' + row.fail);
}
report.totals = {
  pass: report.files.reduce((sum, row) => sum + row.pass, 0),
  fail: report.files.reduce((sum, row) => sum + row.fail, 0),
};
fs.writeFileSync(path.join(destination, 'backend-status.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(
  path.join(destination, 'backend-status.md'),
  [
    '# Rust 后端门禁',
    '| 文件 | 通过 | 失败 |',
    '| --- | --- | --- |',
    ...report.files.map((row) => '| ' + row.file + ' | ' + row.pass + ' | ' + row.fail + ' |'),
    '\n' + JSON.stringify(report.totals),
  ].join('\n') + '\n',
);
console.log(JSON.stringify(report.totals));
process.exitCode = report.totals.fail ? 1 : 0;
