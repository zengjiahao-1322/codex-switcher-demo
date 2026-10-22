'use strict';

const fs = require('node:fs'),
  path = require('node:path'),
  { spawn } = require('node:child_process');
const { PROJECT_ROOT } = require('../src/paths.cjs');
const tests = path.join(PROJECT_ROOT, 'tests');
// 本地和 CI 使用同一个正式测试目录，不混入历史研究脚本。
const files = fs.readdirSync(tests).filter((name) => name.endsWith('.test.cjs'));
if (process.platform === 'win32')
  require('node:child_process').execFileSync(process.execPath, ['scripts/build-windows-helper.cjs'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });
const child = spawn(
  process.execPath,
  ['--test', '--test-timeout=120000', ...files.map((name) => path.join(tests, name))],
  { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
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
