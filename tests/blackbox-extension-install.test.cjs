'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { startBackend } = require('./backend-process.cjs');
const { api } = require('./config-blackbox-helpers.cjs');
test('扩展安装黑盒：仅调用TEMP编辑器官方CLI，带force并保留JS扩展包', async (t) => {
  let marker, root;
  const f = await startBackend(t, {
    setup({ root: temporary, environment }) {
      root = temporary;
      const user = path.join(root, 'user');
      fs.mkdirSync(user);
      environment[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = user;
      environment.LOCALAPPDATA = path.join(root, 'local');
      environment.ProgramFiles = path.join(root, 'programs');
      const base =
        process.platform === 'win32'
          ? path.join(environment.LOCALAPPDATA, 'Programs', 'Microsoft VS Code')
          : path.join(user, 'Applications', 'Visual Studio Code.app', 'Contents');
      const exe = path.join(base, process.platform === 'win32' ? 'Code.exe' : 'MacOS/Electron');
      const app =
        process.platform === 'win32'
          ? path.join(base, 'resources/app')
          : path.join(base, 'Resources/app');
      const shim =
        process.platform === 'win32' ? path.join(base, 'bin/code.cmd') : path.join(app, 'bin/code');
      const cli = path.join(app, 'out/cli.js');
      marker = path.join(root, 'cli-called.json');
      for (const target of [exe, shim, cli])
        fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(process.execPath, exe);
      if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
      fs.writeFileSync(
        cli,
        'require("fs").writeFileSync(' +
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
});
