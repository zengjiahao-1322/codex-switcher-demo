'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const reportDir = process.env.SWITCHER_REPORT_DIR || path.join(root, '.build-cache', 'rust-parity');
fs.mkdirSync(reportDir, { recursive: true });

// The backend script owns the 30 Rust parity files and writes backend-status.json.
require('./test-backend.cjs');
const backendStatusFile = path.join(reportDir, 'backend-status.json');
const backendStatus = JSON.parse(fs.readFileSync(backendStatusFile, 'utf8'));

// Run every remaining test file as well. This includes UI/extension tests and the
// unselected long-poll companion cases; serial execution keeps isolated fixtures
// from sharing timing or temporary-process state.
const backendSource = fs.readFileSync(path.join(__dirname, 'test-backend.cjs'), 'utf8');
const backendFiles = new Set(
  [...backendSource.matchAll(/^  '([^']+\.test\.cjs)':/gm)].map((match) => match[1]),
);
const remaining = fs
  .readdirSync(path.join(root, 'tests'))
  .filter((file) => file.endsWith('.test.cjs') && !backendFiles.has(file))
  .sort();
const tapFile = path.join(reportDir, 'tests-rest.tap');
const run = spawnSync(
  process.execPath,
  [
    '--experimental-vm-modules',
    '--test',
    '--test-concurrency=1',
    '--test-reporter=tap',
    ...remaining.map((file) => path.join(root, 'tests', file)),
  ],
  { cwd: root, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 900000 },
);
const output = (run.stdout || '') + (run.stderr || '');
fs.writeFileSync(tapFile, output);
const rest = {
  files: remaining,
  pass: Number(output.match(/^# pass (\d+)$/m)?.[1] || 0),
  fail:
    Number(output.match(/^# fail (\d+)$/m)?.[1] || 0) +
    Number(output.match(/^# cancelled (\d+)$/m)?.[1] || 0),
  skipped: Number(output.match(/^# skipped (\d+)$/m)?.[1] || 0),
  exitCode: run.status,
  runnerError: run.error?.message || null,
  tapFile,
};
// The first three long-poll cases ran in the parity gate; the companion cases
// live in the same file, so select their complementary name range explicitly.
const companionRun = spawnSync(
  process.execPath,
  [
    '--experimental-vm-modules',
    '--test',
    '--test-concurrency=1',
    '--test-reporter=tap',
    '--test-name-pattern=^(服务器支持长轮询|重载完成待确认|切换器不可用)',
    path.join(root, 'tests', 'long-poll.test.cjs'),
  ],
  { cwd: root, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 180000 },
);
const companionOutput = (companionRun.stdout || '') + (companionRun.stderr || '');
const companionTap = path.join(reportDir, 'tests-rest-long-poll.tap');
fs.writeFileSync(companionTap, companionOutput);
rest.longPoll = {
  pass: Number(companionOutput.match(/^# pass (\d+)$/m)?.[1] || 0),
  fail:
    Number(companionOutput.match(/^# fail (\d+)$/m)?.[1] || 0) +
    Number(companionOutput.match(/^# cancelled (\d+)$/m)?.[1] || 0),
  exitCode: companionRun.status,
  runnerError: companionRun.error?.message || null,
  tapFile: companionTap,
};
rest.pass += rest.longPoll.pass;
rest.fail += rest.longPoll.fail;
fs.writeFileSync(path.join(reportDir, 'tests-rest-status.json'), JSON.stringify(rest, null, 2));
if (run.status !== 0) process.stdout.write(output);
if (companionRun.status !== 0) process.stdout.write(companionOutput);
const result = {
  backend: backendStatus.totals,
  tests: { pass: rest.pass, fail: rest.fail, files: remaining.length },
};
console.log(JSON.stringify(result));
process.exitCode =
  backendStatus.totals.fail || rest.fail || run.status || companionRun.status ? 1 : 0;
