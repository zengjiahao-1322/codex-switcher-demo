'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { startBackend } = require('./backend-process.cjs');
const { api } = require('./config-blackbox-helpers.cjs');

// A fake VS Code under TEMP whose official CLI records its call and "installs" the companion.
function fakeEditor(root, environment) {
  const user = path.join(root, 'user');
  fs.mkdirSync(user);
  environment[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = user;
  environment.LOCALAPPDATA = path.join(root, 'local');
  environment.ProgramFiles = path.join(root, 'programs');
  environment.SWITCHER_TEST_EXTENSION_ROOT = path.join(user, '.vscode', 'extensions');
  environment.SWITCHER_TEST_PACKAGE = path.resolve('package.json');
  const base =
    process.platform === 'win32'
      ? path.join(environment.LOCALAPPDATA, 'Programs', 'Microsoft VS Code')
      : path.join(user, 'Applications', 'Visual Studio Code.app', 'Contents');
  const exe = path.join(base, process.platform === 'win32' ? 'Code.exe' : 'MacOS/Electron');
  const app =
    process.platform === 'win32' ? path.join(base, 'resources/app') : path.join(base, 'Resources/app');
  const shim =
    process.platform === 'win32' ? path.join(base, 'bin/code.cmd') : path.join(app, 'bin/code');
  const cli = path.join(app, 'out/cli.js');
  const marker = path.join(root, 'cli-called.json');
  for (const target of [exe, shim, cli]) fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(process.execPath, exe);
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  fs.writeFileSync(
    cli,
    'const fs=require("fs"),path=require("path");' +
      'if(process.argv.includes("--install-extension")){const d=path.join(process.env.SWITCHER_TEST_EXTENSION_ROOT,"codex-switcher-demo.codex-switcher-companion-"+require(process.env.SWITCHER_TEST_PACKAGE).version);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,"package.json"),JSON.stringify(require(process.env.SWITCHER_TEST_PACKAGE)));fs.writeFileSync(path.join(process.env.SWITCHER_TEST_EXTENSION_ROOT,"extensions.json"),JSON.stringify([{identifier:{id:"codex-switcher-demo.codex-switcher-companion"},relativeLocation:path.basename(d)}]));}' +
      'fs.writeFileSync(' +
      JSON.stringify(marker) +
      ', JSON.stringify({args:process.argv.slice(2),electron:process.env.ELECTRON_RUN_AS_NODE}));\n',
  );
  fs.writeFileSync(
    shim,
    process.platform === 'win32'
      ? '"%~dp0..\\Code.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*\r\n'
      : '#!/bin/sh\n',
  );
  if (process.platform !== 'win32')
    fs.writeFileSync(
      path.join(base, 'Info.plist'),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Electron</string></dict></plist>',
    );
  return marker;
}

test('扩展安装黑盒：仅调用TEMP编辑器官方CLI，带force并保留JS扩展包', async (t) => {
  let marker;
  const f = await startBackend(t, {
    setup({ root, environment }) {
      marker = fakeEditor(root, environment);
    },
  });
  const clients = await api(f, 'clients', {});
  assert.equal(clients.editors.length, 1, 'Never invoke an ambiguous or real editor installation');
  assert.equal(clients.editors[0].name, 'VS Code');
  await api(f, 'companionInstall', { id: clients.editors[0].id });
  const recorded = JSON.parse(fs.readFileSync(marker));
  assert.equal(recorded.electron, '1');
  assert.equal(recorded.args[0], '--install-extension');
  assert.equal(recorded.args[2], '--force');
  assert.equal(path.dirname(recorded.args[1]), f.bridge);
  assert.ok(fs.readFileSync(recorded.args[1]).includes(Buffer.from('extension/package.json')));
  await api(f, 'companionInstall', { id: 99999 }, 400);
  fs.mkdirSync(path.join(f.bridge, 'clients'), { recursive: true });
  fs.writeFileSync(
    path.join(f.bridge, 'clients', 'separate-window.json'),
    JSON.stringify({
      id: 'separate-window',
      name: 'VS Code',
      workspace: 'independent',
      seenAt: Date.now(),
      codexHome: path.join(f.root, 'separate'),
    }),
  );
  const updated = await api(f, 'updateCompanions', {});
  assert.equal(updated.results.length, 1);
  assert.equal(updated.results[0].name, 'VS Code');
  assert.equal(updated.results[0].error, undefined);
  assert.equal(updated.reload.count, 1);
  assert.equal(updated.reload.targets[0].id, 'separate-window');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.bridge, 'clients', 'separate-window.json'))).command.type,
    'reload',
  );
});

test('切换器升级后自动更新已装的旧版伴随扩展，并记下这个版本', async (t) => {
  let marker, extensions;
  const f = await startBackend(t, {
    setup({ root, environment }) {
      marker = fakeEditor(root, environment);
      extensions = environment.SWITCHER_TEST_EXTENSION_ROOT;
      // An installed build: release-info.json carries a sequence, next to the packaged companion.
      const pkg = path.join(root, 'pkg');
      fs.mkdirSync(path.join(pkg, 'web'), { recursive: true });
      fs.cpSync(path.resolve('vscode-companion'), path.join(pkg, 'vscode-companion'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'release-info.json'), JSON.stringify({ sequence: 5 }));
      environment.SWITCHER_WEB_ROOT = path.join(pkg, 'web');
      const old = path.join(extensions, 'codex-switcher-demo.codex-switcher-companion-0.0.1');
      fs.mkdirSync(old, { recursive: true });
      fs.writeFileSync(path.join(old, 'package.json'), JSON.stringify({ version: '0.0.1' }));
      fs.writeFileSync(
        path.join(extensions, 'extensions.json'),
        JSON.stringify([
          { identifier: { id: 'codex-switcher-demo.codex-switcher-companion' }, relativeLocation: path.basename(old) },
        ]),
      );
    },
  });
  const version = require(path.resolve('package.json')).version;
  const follow = path.join(f.bridge, 'companion-follow.json');
  for (let i = 0; i < 300 && !fs.existsSync(follow); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(JSON.parse(fs.readFileSync(follow)).version, version);
  assert.equal(JSON.parse(fs.readFileSync(marker)).args[0], '--install-extension');
  assert.ok(fs.existsSync(path.join(extensions, 'codex-switcher-demo.codex-switcher-companion-' + version)));
});
