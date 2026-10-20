'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');
const assert = require('node:assert/strict');
const project = path.resolve(__dirname, '..');
// macOS 的 Unix socket 路径上限较短，测试配置目录不能放在长 /var/folders 路径下。
const root = fs.mkdtempSync(
  path.join(
    process.env.SWITCHER_VERIFY_HOME || (process.platform === 'darwin' ? '/tmp' : os.tmpdir()),
    'swe-',
  ),
);
const report = { platform: process.platform, arch: process.arch, checks: [] };
const processes = [];
let server, upstream;

async function waitFor(read, description, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw Error('Timed out: ' + description);
}

function activations(folder) {
  const file = path.join(folder, 'activations.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

async function initializeHome(executable, home) {
  // 先完成官方运行时的首次数据库迁移，避免把两个全新数据库初始化的竞争当作重载失败。
  const child = cp.spawn(executable, ['app-server'], {
    env: { ...process.env, CODEX_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  let output = '';
  let errors = '';
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stdin.write(
    JSON.stringify({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'switcher-database-setup', version: '1' },
      },
    }) + '\n',
  );
  try {
    await waitFor(
      () => {
        if (child.exitCode !== null) throw Error('初始化 Codex 数据库失败：' + errors);
        return output.split('\n').some((line) => {
          try {
            return JSON.parse(line).id === 1 && JSON.parse(line).result;
          } catch {
            return false;
          }
        });
      },
      'initial Codex database setup',
      20000,
    );
  } finally {
    child.kill();
    await closed;
  }
}

(async () => {
  try {
    const { downloadAndUnzipVSCode } = require(
      path.join(
        project,
        '.build-cache',
        'editor-check',
        'node_modules',
        '@vscode',
        'test-electron',
      ),
    );
    let editor =
      process.env.SWITCHER_VERIFY_EDITOR ||
      (await downloadAndUnzipVSCode({
        version: 'stable',
        cachePath: path.join(project, '.build-cache', 'vscode-test'),
      }));
    let editorEntry;
    if (process.platform === 'darwin') {
      // 测试下载器可能仍返回旧版 Electron 名称，以下载包的真实元数据为准。
      const versionRoot = path.resolve(editor, '../../../..');
      report.downloadedBundleEntries = fs.readdirSync(versionRoot);
      const app = report.downloadedBundleEntries.find((name) => name.endsWith('.app'));
      assert.ok(app, 'VS Code 下载目录必须有应用包');
      const bundle = path.join(versionRoot, app, 'Contents');
      const name = cp
        .execFileSync(
          '/usr/libexec/PlistBuddy',
          ['-c', 'Print :CFBundleExecutable', path.join(bundle, 'Info.plist')],
          { encoding: 'utf8' },
        )
        .trim();
      report.editorExecutableName = name;
      editor = path.join(bundle, 'MacOS', name);
      const shim = path.join(bundle, 'Resources', 'app', 'bin', 'code');
      editorEntry = require('../editor-integration.cjs').cliFor(shim);
      assert.equal(editorEntry.exe, editor);
      report.checks.push('actual-Mac-editor-CLI-from-bundle-metadata');
    } else {
      editorEntry = require('../editor-integration.cjs').cliFor(
        path.join(path.dirname(editor), 'bin', 'code.cmd'),
      );
    }
    assert.ok(fs.existsSync(editor), '编辑器入口必须存在：' + editor);
    const executable = require('../runtime.cjs').findCodex();
    const selected = path.join(root, 'shared-home');
    const separate = path.join(root, 'separate-home');
    const bridge = path.join(root, 'bridge');
    process.env.BRIDGE_HOME = bridge;
    const extensions = path.join(root, 'installed-extensions');
    const vsix = require('../editor-integration.cjs').build(project);
    // 普通安装避免扩展开发宿主只允许一个开发窗口，真实覆盖同一实例的多个窗口。
    const fixtureVsix = require('../zip.cjs').zip(
      [
        {
          name: 'extension/package.json',
          file: path.join(__dirname, 'editor-fixture', 'package.json'),
        },
        {
          name: 'extension/extension.cjs',
          file: path.join(__dirname, 'editor-fixture', 'extension.cjs'),
        },
        {
          name: '[Content_Types].xml',
          file: path.join(project, 'vscode-companion', 'content-types.xml'),
        },
        {
          name: 'extension.vsixmanifest',
          data: `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Language="en-US" Id="switcher-reload-fixture" Version="0.0.1" Publisher="switcher-test"/>
<DisplayName>Switcher reload fixture</DisplayName><Description xml:space="preserve">Isolated editor verification.</Description>
<Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.85.0"/></Properties></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>`,
        },
      ],
      path.join(root, 'editor-fixture.vsix'),
    );
    report.extensionInstall = '';
    for (const packageFile of [vsix, fixtureVsix])
      report.extensionInstall += cp.execFileSync(
        editorEntry.exe,
        [
          editorEntry.cli,
          '--install-extension',
          packageFile,
          '--force',
          '--extensions-dir',
          extensions,
          '--user-data-dir',
          path.join(root, 'installer-profile'),
        ],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60000 },
      );
    report.checks.push(
      'actual-offline-companion-VSIX-install',
      'actual-offline-fixture-VSIX-install',
    );
    for (const home of [selected, separate]) {
      fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
      fs.writeFileSync(
        path.join(home, 'config.toml'),
        'model="before-reload"\ncli_auth_credentials_store="file"\n',
      );
      fs.writeFileSync(
        path.join(home, 'sessions', 'saved-history.jsonl'),
        'saved-history-marker\n',
      );
      await initializeHome(executable, home);
    }
    const service = require('../service.cjs').createService({
      codexHome: selected,
      bridgeHome: bridge,
      hermesHome: path.join(root, 'no-hermes'),
      projectDir: project,
    });
    const token = crypto.randomBytes(32).toString('hex');
    server = require('../server.cjs').createServer({
      token,
      getState: service.state,
      actions: service.actions,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const connection = path.join(root, 'connection.json');
    fs.writeFileSync(connection, JSON.stringify({ url: origin + '/#' + token }));
    const api = async (name, input = {}) => {
      const response = await fetch(origin + '/api/' + name, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const value = await response.json();
      assert.equal(response.status, 200, value.error);
      return value;
    };
    const folders = ['shared-a', 'shared-b', 'separate'].map((name) => path.join(root, name));
    for (const [index, folder] of folders.entries()) {
      const home = index === 2 ? separate : selected;
      fs.mkdirSync(path.join(folder, '.vscode'), { recursive: true });
      fs.writeFileSync(path.join(folder, 'fixture.json'), JSON.stringify({ home, executable }));
      fs.writeFileSync(
        path.join(folder, '.vscode', 'settings.json'),
        JSON.stringify({
          'codexSwitcher.connectionFile': connection,
          'telemetry.telemetryLevel': 'off',
        }),
      );
      const child = cp.spawn(
        editor,
        [
          '--new-window',
          '--skip-welcome',
          '--skip-release-notes',
          '--disable-workspace-trust',
          '--disable-gpu',
          '--user-data-dir=' + path.join(root, 'profiles', index === 2 ? 'separate' : 'shared'),
          '--extensions-dir=' + extensions,
          folder,
        ],
        {
          env: { ...process.env, CODEX_HOME: home },
          windowsHide: true,
          detached: process.platform === 'darwin',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const log = fs.createWriteStream(path.join(root, 'editor-' + index + '.log'));
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      processes.push({
        child,
        folder,
        closed: new Promise((resolve) => child.once('exit', resolve)),
      });
      if (index === 0)
        await waitFor(() => activations(folder).length, 'first ordinary editor window starts');
    }
    await waitFor(
      () => folders.every((folder) => activations(folder).length),
      'three real extension hosts',
    );
    const initial = folders.map((folder) => activations(folder)[0]);
    assert.ok(initial.every((entry) => entry.configuration.model === 'before-reload'));
    const before = await waitFor(async () => {
      const status = await api('clients');
      const editors = status.clients.filter((client) => client.kind === 'editor');
      return (
        editors.length === 3 && editors.filter((client) => client.canReload).length === 2 && status
      );
    }, 'two shared windows and one isolated window');
    report.checks.push('real-VS-Code-companion-heartbeats', 'native-backend-window-association');
    report.checks.push('two-shared-windows-in-one-editor-instance');
    report.before = before.clients
      .filter((client) => client.kind === 'editor')
      .map((client) => ({
        workspace: path.basename(client.workspace),
        shared: client.shared,
        canReload: client.canReload,
      }));
    // 走用户真正点击的应用接口，覆盖后台 worker、配置应用和窗口重载的整条链路。
    const requests = [];
    upstream = http.createServer((request, response) => {
      requests.push(request.url);
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            object: 'response',
            status: 'completed',
            output: [
              {
                type: 'function_call',
                name: 'bridge_ping',
                arguments: '{"ok":true}',
                call_id: 'fixture-ping',
              },
            ],
          }),
        );
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const providerId = require('../providers.cjs').add(bridge, {
      name: 'Editor switch fixture',
      baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1',
      apiMode: 'responses',
      model: 'after-reload',
      apiKey: 'fixture-key',
    });
    // 保留用户已有的速度设置，切来源不引入额外速度操作。
    fs.appendFileSync(
      path.join(selected, 'config.toml'),
      'service_tier="fast"\n[features]\nfast_mode=true\n',
    );
    await api('desktopSwitch', { id: providerId, model: 'after-reload', reloadEditors: true });
    const job = await waitFor(async () => {
      const state = await api('accounts');
      if (state.switchJob?.status === 'error') throw Error(state.switchJob.message);
      return state.switchJob?.status === 'done' && state.switchJob;
    }, 'complete official-to-API switch');
    assert.equal(job.desktopRequested, false, 'IDE-only switch must not open a desktop app');
    assert.equal(job.configurationApplied, true);
    assert.ok(requests.includes('/v1/responses'));
    const result = job.editorReload;
    assert.equal(result.count, 2);
    report.checks.push('full-official-config-to-API-worker-and-reload');
    await waitFor(
      () => folders.slice(0, 2).every((folder) => activations(folder).length >= 2),
      'both shared windows reload',
    );
    await waitFor(
      () =>
        require('../client-status.cjs')
          .reloadResults(bridge, result.targets)
          .every((r) => r.status === 'reloaded'),
      'companion confirms each completed reload',
    );
    for (let index = 0; index < 2; index++) {
      const latest = activations(folders[index]).at(-1);
      assert.notEqual(latest.extensionHostPid, initial[index].extensionHostPid);
      assert.notEqual(latest.backendPid, initial[index].backendPid);
      assert.equal(latest.configuration.model, 'after-reload');
      assert.equal(latest.configuration.model_provider, 'hermes_bridge');
      assert.equal(
        latest.configuration.model_providers.hermes_bridge.base_url,
        'http://127.0.0.1:' + upstream.address().port + '/v1',
      );
      assert.equal(latest.configuration.service_tier, 'fast');
    }
    assert.equal(activations(folders[2]).length, 1);
    assert.equal(activations(folders[2])[0].backendPid, initial[2].backendPid);
    // RPC 会把未设置的档位序列化为 null；独立窗口必须保留原值，且不能变成 Fast。
    const independentTier = activations(folders[2])[0].configuration.service_tier;
    assert.equal(independentTier, initial[2].configuration.service_tier);
    assert.ok(independentTier == null);
    for (const home of [selected, separate]) {
      assert.equal(
        fs.readFileSync(path.join(home, 'sessions', 'saved-history.jsonl'), 'utf8'),
        'saved-history-marker\n',
      );
    }
    report.checks.push(
      'two-window-actual-reload',
      'companion-confirmed-reload-results',
      'new-backends-read-new-config',
      'shared-windows-read-Fast-setting',
      'independent-window-untouched',
      'saved-history-files-preserved',
    );
    // 在真实后端已经停止后注入同步错误，确认失败清理能恢复两个插件窗口。
    const beforeRecovery = folders.map((folder) => activations(folder).at(-1));
    const counts = folders.map((folder) => activations(folder).length);
    await waitFor(async () => {
      const clients = (await api('clients')).clients;
      return clients.filter((c) => c.kind === 'editor' && c.canReload).length === 2;
    }, 'reloaded windows reconnect before failure recovery');
    await assert.rejects(
      require('../desktop-account.cjs').runSwitch(
        {
          codexHome: selected,
          bridgeHome: bridge,
          id: 'recovery-fixture',
          desktopExe: null,
        },
        {
          accounts: {
            syncCurrent: async () => {},
            prepare: async () => {},
            apply: () => ({ label: 'Fixture' }),
          },
          syncThreads: async () => {
            for (const entry of beforeRecovery.slice(0, 2)) {
              assert.throws(() => process.kill(entry.backendPid, 0));
            }
            assert.doesNotThrow(() => process.kill(beforeRecovery[2].backendPid, 0));
            throw Error('fixture sync failure');
          },
        },
      ),
      /fixture sync failure/,
    );
    const failedJob = JSON.parse(fs.readFileSync(path.join(bridge, 'account-switch.json')));
    assert.equal(failedJob.status, 'error');
    assert.equal(failedJob.editorReload.count, 2);
    await waitFor(
      () => folders.slice(0, 2).every((folder, i) => activations(folder).length > counts[i]),
      'both stopped backends recover after sync failure',
    );
    await waitFor(
      () =>
        require('../client-status.cjs')
          .reloadResults(bridge, failedJob.editorReload.targets)
          .every((r) => r.status === 'reloaded'),
      'recovery reloads are acknowledged',
    );
    assert.equal(activations(folders[2]).length, counts[2]);
    for (let i = 0; i < 2; i++) {
      const latest = activations(folders[i]).at(-1);
      assert.notEqual(latest.backendPid, beforeRecovery[i].backendPid);
      assert.equal(latest.configuration.model_provider, 'hermes_bridge');
    }
    report.checks.push(
      'injected-sync-failure-restores-real-shared-backends',
      'failed-switch-still-reports-error-and-reload-results',
    );
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = error.stack;
    for (const file of fs.readdirSync(root).filter((file) => /^editor-\d\.log$/.test(file))) {
      report[file] = fs.readFileSync(path.join(root, file), 'utf8').slice(-8000);
    }
    // 保留真实扩展宿主的诊断，不把主进程的启动成功误认为扩展已经激活。
    const collect = (directory) =>
      fs.existsSync(directory)
        ? fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) return collect(file);
            return /^(?:exthost|renderer|fixture-trace)\.log$/.test(entry.name) ? [file] : [];
          })
        : [];
    report.extensionLogs = collect(root)
      .slice(0, 12)
      .map((file) => ({
        file: path.relative(root, file),
        text: fs.readFileSync(file, 'utf8').slice(-6000),
      }));
    process.exitCode = 1;
  } finally {
    report.checkedAt = new Date().toISOString();
    fs.mkdirSync(path.join(project, 'verification'), { recursive: true });
    fs.writeFileSync(
      path.join(project, 'verification', 'editor-reload.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    for (const entry of processes) fs.writeFileSync(path.join(entry.folder, 'stop'), '');
    for (const entry of processes) {
      await Promise.race([entry.closed, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        if (process.platform === 'win32')
          cp.spawnSync('taskkill.exe', ['/PID', String(entry.child.pid), '/T', '/F'], {
            windowsHide: true,
          });
        else entry.child.kill('SIGTERM');
      }
      if (process.platform === 'darwin') {
        // 仅终止本测试创建的独立进程组，避免扩展宿主遗留的心跳让测试服务无法退出。
        try {
          process.kill(-entry.child.pid, 'SIGTERM');
        } catch {}
      }
      entry.child.stdout.destroy();
      entry.child.stderr.destroy();
      entry.child.unref();
    }
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (upstream) {
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
    }
  }
})();
