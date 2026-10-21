const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
test('discovers newest installed codex binary without pinning version hash', () => {
  const { findCodex } = require('../src/platform/runtime.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-runtime-'));
  try {
    for (const n of ['old', 'new']) {
      fs.mkdirSync(path.join(root, n));
      fs.writeFileSync(path.join(root, n, 'codex.exe'), 'test fixture');
    }
    fs.utimesSync(path.join(root, 'old', 'codex.exe'), new Date(1000), new Date(1000));
    assert.equal(findCodex(root), path.join(root, 'new', 'codex.exe'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('IDE-only lookup selects the native extension in VS Code, Insiders and Cursor without CODEX_EXE', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-ide-only-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const platform of ['darwin', 'win32'])
    for (const arch of ['arm64', 'x64'])
      for (const editor of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
        const home = path.join(root, platform, arch, editor),
          dir = path.join(home, editor, 'extensions', 'openai.chatgpt-26.1007.21434'),
          cpu = arch === 'arm64' ? 'aarch64' : 'x86_64',
          file = path.join(
            dir,
            'bin',
            (platform === 'darwin' ? 'macos-' : 'windows-') + cpu,
            platform === 'win32' ? 'codex.exe' : 'codex',
          );
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'runtime fixture');
        assert.equal(
          require('../src/platform/runtime.cjs').findCodex({
            platform,
            arch,
            home,
            env: {},
            appPaths: [],
          }),
          fs.realpathSync(file),
        );
      }
});

test('IDE-only lookup accepts an OpenAI Codex extension whose package id differs by editor channel', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-extension-channel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const extension = path.join(root, '.windsurf', 'extensions', 'openai.codex-1.0.0'),
    cpu = process.arch === 'arm64' ? 'aarch64' : 'x86_64',
    binary = path.join(
      extension,
      'bin',
      (process.platform === 'darwin' ? 'macos-' : 'windows-') + cpu,
      process.platform === 'win32' ? 'codex.exe' : 'codex',
    );
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(
    path.join(extension, 'package.json'),
    JSON.stringify({ name: 'codex', displayName: 'Codex', publisher: 'openai' }),
  );
  fs.writeFileSync(binary, 'fixture');
  assert.equal(
    require('../src/platform/runtime.cjs').findCodex({
      platform: process.platform,
      arch: process.arch,
      home: root,
      env: {},
      appPaths: [],
    }),
    fs.realpathSync(binary),
  );
});

test('HTTP 上报的非安装路径不能作为自动运行程序，即使文件名为 codex', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-untrusted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, process.platform === 'win32' ? 'codex.exe' : 'codex');
  fs.writeFileSync(file, 'fixture');
  const { findCodex, isTrustedCodex } = require('../src/platform/runtime.cjs');
  assert.equal(isTrustedCodex(file, { home: root }), false);
  assert.throws(
    () =>
      findCodex({
        platform: process.platform,
        env: {},
        home: root,
        windowsRoot: path.join(root, 'not-installed'),
        appPaths: [],
        hints: [file],
      }),
    { code: 'CODEX_NOT_FOUND' },
  );
});
