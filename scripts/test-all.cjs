'use strict';

const fs = require('node:fs'),
  path = require('node:path'),
  { spawn } = require('node:child_process');
const { PROJECT_ROOT } = require('../src/paths.cjs');
if (process.env.SWITCHER_BACKEND === 'rust') {
  require('./test-backend.cjs');
  return;
}
const tests = path.join(PROJECT_ROOT, 'tests');
// 本地和 CI 使用同一个正式测试目录，不混入历史研究脚本。
const files = fs.readdirSync(tests).filter((name) => name.endsWith('.test.cjs'));
if (process.platform === 'win32')
  require('node:child_process').execFileSync(
    process.execPath,
    ['scripts/build-windows-helper.cjs'],
    {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    },
  );
// 前端测试在假页面里按 ES 模块加载 web/js，需要 vm 模块支持。
const child = spawn(
  process.execPath,
  [
    '--experimental-vm-modules',
    '--test',
    // Desktop-shaped TEMP processes are visible to every process scanner.
    '--test-concurrency=1',
    // The remote activation black box observes the full 120-second lease.
    '--test-timeout=180000',
    '--test-reporter=./scripts/test-inventory-reporter.cjs',
    ...files.map((name) => path.join(tests, name)),
  ],
  {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SWITCHER_TEST_INVENTORY:
        process.env.SWITCHER_TEST_INVENTORY ||
        path.join(PROJECT_ROOT, '.build-cache', 'node-test-inventory.json'),
    },
  },
);
let output = '';
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    output += chunk;
    (stream === child.stdout ? process.stdout : process.stderr).write(chunk);
  });
}
child.on('error', (error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
child.on('close', (code) => {
  if (!process.argv.includes('--no-report')) {
    fs.mkdirSync(path.join(PROJECT_ROOT, 'verification'), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_ROOT, 'verification', 'test-results.tap'), output);
  }
  process.exitCode = code === null ? 1 : code;
});
