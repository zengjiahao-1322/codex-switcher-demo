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

// The others call JS modules or use JS mocks directly. Running them unchanged
// cannot establish Rust parity. Keep their names/counts in the migration table.
const httpPatterns = {
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
  'blackbox-framework.test.cjs': '.*',
  'blackbox-diagnostics.test.cjs': '.*',
  'blackbox-platform.test.cjs': '.*',
  'blackbox-config.test.cjs': '.*',
  'blackbox-config-algorithm.test.cjs': '.*',
  'blackbox-config-matrix.test.cjs': '.*',
  'blackbox-config-backups.test.cjs': '.*',
  'blackbox-config-network.test.cjs': '.*',
  'server.test.cjs': '.*',
  'server-adapter.test.cjs': '.*',
  'main.test.cjs': '.*',
  'startup-log.test.cjs': '.*',
  'long-poll.test.cjs': '^(不带 wait|带 wait=|挂起期间另一进程|多个挂起窗口)',
  'remote-servers.test.cjs': '^(HTTP心跳|独立remoteSwitch)',
};
const report = {
  backend: 'rust',
  generatedAt: new Date().toISOString(),
  fixtureCallbacksForwarded: false,
  files: [],
};
report.classification = {
  http: 'Process black boxes use Rust; legacy transport tests are retained separately, including unsupported JS callback semantics and later-batch failures.',
  nodeOnly:
    'Calls JS modules, injects JS callbacks, or tests the existing Node package/launcher. Not Rust verification.',
  needsRustRewrite:
    'File-level conservative count of Node-only tests in files that directly import src/*.cjs; mixed UI/extension cases need later splitting.',
};
const inventoryFile =
  process.env.SWITCHER_TEST_INVENTORY ||
  path.join(root, '.build-cache', 'node-test-inventory.json');
if (!fs.existsSync(inventoryFile))
  throw Error(
    'Run Node scripts/test-all.cjs --no-report first to collect the actual declared test inventory, including generated test names.',
  );
const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
const keptJsFiles = new Set([
  'companion-remote.test.cjs',
  'remote-agent.test.cjs',
  'source-ui.test.cjs',
  'remotes-ui.test.cjs',
  'backup-ui.test.cjs',
]);
for (const file of fs
  .readdirSync(path.join(root, 'tests'))
  .filter((file) => file.endsWith('.test.cjs'))
  .sort()) {
  const source = fs.readFileSync(path.join(root, 'tests', file), 'utf8');
  const names = inventory.filter((test) => test.file === file).map((test) => test.name);
  if (!names.length)
    throw Error(
      'Test inventory is stale for ' + file + '; run Node scripts/test-all.cjs --no-report first.',
    );
  const pattern = httpPatterns[file];
  const http = pattern ? names.filter((name) => new RegExp(pattern).test(name)) : [];
  const nodeOnly = names.filter((name) => !http.includes(name));
  const row = {
    file,
    suiteKind: file.startsWith('blackbox-') ? '双后台黑盒' : '既有传输/混合测试',
    declared: names.length,
    httpTests: http,
    nodeOnly,
    keptJs: keptJsFiles.has(file) ? nodeOnly.length : 0,
    needsRustRewrite:
      !keptJsFiles.has(file) && /require\(['"]\.\.\/src\//.test(source) ? nodeOnly.length : 0,
    pass: 0,
    fail: 0,
    status: keptJsFiles.has(file) ? '保持 JS' : '仅 Node/JS 单元测试',
  };
  if (http.length) {
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
      {
        cwd: root,
        env: { ...process.env, SWITCHER_BACKEND: 'rust' },
        encoding: 'utf8',
        timeout: 180000,
        windowsHide: true,
      },
    );
    const output = (run.stdout || '') + (run.stderr || '');
    fs.writeFileSync(path.join(destination, file + '.tap'), output);
    row.exitCode = run.status;
    row.runnerError = run.error?.message || null;
    row.pass = Number(output.match(/^# pass (\d+)$/m)?.[1] || 0);
    row.fail =
      Number(output.match(/^# fail (\d+)$/m)?.[1] || 0) +
      Number(output.match(/^# cancelled (\d+)$/m)?.[1] || 0);
    row.status = run.status === 0 ? '通过' : '失败';
    if (run.status !== 0 && row.fail === 0) row.fail = http.length;
    row.details = [...output.matchAll(/^(not ok|ok) \d+ - (.+)$/gm)].map((match) => ({
      name: match[2],
      status: match[1] === 'ok' ? 'pass' : 'fail',
    }));
  }
  report.files.push(row);
  console.log(
    file +
      ': ' +
      row.status +
      ', pass=' +
      row.pass +
      ', fail=' +
      row.fail +
      ', Node/JS only=' +
      nodeOnly.length,
  );
}
report.totals = {
  files: report.files.length,
  httpFiles: report.files.filter((row) => row.httpTests.length).length,
  pass: report.files.reduce((n, row) => n + row.pass, 0),
  fail: report.files.reduce((n, row) => n + row.fail, 0),
  nodeOnly: report.files.reduce((n, row) => n + row.nodeOnly.length, 0),
  keptJs: report.files.reduce((n, row) => n + row.keptJs, 0),
  needsRustRewrite: report.files.reduce((n, row) => n + row.needsRustRewrite, 0),
};
report.blackbox = {
  pass: report.files
    .filter((row) => row.suiteKind === '双后台黑盒')
    .reduce((n, row) => n + row.pass, 0),
  fail: report.files
    .filter((row) => row.suiteKind === '双后台黑盒')
    .reduce((n, row) => n + row.fail, 0),
};
fs.writeFileSync(path.join(destination, 'backend-status.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(
  path.join(destination, 'backend-status.md'),
  [
    '# Rust 后台：测试文件现状',
    'HTTP 测试使用 Rust 进程；JS getState/actions/进程 mock 不转发给 Node。JS 注入依赖的用例以后需改写成 HTTP/磁盘夹具或 Rust 单元测试。Node/JS-only 不是 Rust 通过。',
    '| 文件 | Rust HTTP 通过 | Rust HTTP 失败 | 仅 Node/JS | 保持 JS | 后端单元待改写 | 状态 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.files.map(
      (row) =>
        `| ${row.file} | ${row.pass} | ${row.fail} | ${row.nodeOnly.length} | ${row.keptJs} | ${row.needsRustRewrite} | ${row.status} |`,
    ),
    '\n' + JSON.stringify(report.totals),
  ].join('\n') + '\n',
);
console.log(JSON.stringify(report.totals));
process.exitCode = report.totals.fail ? 1 : 0;
