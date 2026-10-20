'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const project = path.resolve(__dirname, '..');
// macOS 的 Unix socket 路径上限较短，测试配置目录不能放在长 /var/folders 路径下。
const root = fs.mkdtempSync(
  path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'swe-'),
);
const report = { platform: process.platform, arch: process.arch, checks: [] };
const processes = [];
let server;

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
    let editor = await downloadAndUnzipVSCode({
      version: 'stable',
      cachePath: path.join(project, '.build-cache', 'vscode-test'),
    });
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
    report.extensionInstall = cp.execFileSync(
      editorEntry.exe,
      [
        editorEntry.cli,
        '--install-extension',
        vsix,
        '--force',
        '--extensions-dir',
        extensions,
        '--user-data-dir',
        path.join(root, 'installer-profile'),
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60000 },
    );
    report.checks.push('actual-offline-companion-VSIX-install');
    for (const home of [selected, separate]) {
      fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(home, 'config.toml'), 'model="before-reload"\n');
      fs.writeFileSync(
        path.join(home, 'sessions', 'saved-history.jsonl'),
        'saved-history-marker\n',
      );
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
          '--user-data-dir=' + path.join(root, 'profiles', String(index)),
          '--extensions-dir=' + extensions,
          '--extensionDevelopmentPath=' + path.join(project, 'scripts', 'editor-fixture'),
          folder,
        ],
        {
          env: { ...process.env, CODEX_HOME: home },
          windowsHide: true,
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
    }
    await waitFor(
      () => folders.every((folder) => activations(folder).length),
      'three real extension hosts',
    );
    const initial = folders.map((folder) => activations(folder)[0]);
    const before = await waitFor(async () => {
      const status = await api('clients');
      const editors = status.clients.filter((client) => client.kind === 'editor');
      return (
        editors.length === 3 && editors.filter((client) => client.canReload).length === 2 && status
      );
    }, 'two shared windows and one isolated window');
    report.checks.push('real-VS-Code-companion-heartbeats', 'native-backend-window-association');
    report.before = before.clients
      .filter((client) => client.kind === 'editor')
      .map((client) => ({
        workspace: path.basename(client.workspace),
        shared: client.shared,
        canReload: client.canReload,
      }));
    fs.writeFileSync(path.join(selected, 'config.toml'), 'model="after-reload"\n');
    const result = await api('reloadClients');
    assert.equal(result.count, 2);
    await waitFor(
      () => folders.slice(0, 2).every((folder) => activations(folder).length >= 2),
      'both shared windows reload',
    );
    for (let index = 0; index < 2; index++) {
      const latest = activations(folders[index]).at(-1);
      assert.notEqual(latest.extensionHostPid, initial[index].extensionHostPid);
      assert.notEqual(latest.backendPid, initial[index].backendPid);
      assert.match(latest.configuration, /after-reload/);
    }
    assert.equal(activations(folders[2]).length, 1);
    assert.equal(activations(folders[2])[0].backendPid, initial[2].backendPid);
    for (const home of [selected, separate]) {
      assert.equal(
        fs.readFileSync(path.join(home, 'sessions', 'saved-history.jsonl'), 'utf8'),
        'saved-history-marker\n',
      );
    }
    report.checks.push(
      'two-window-actual-reload',
      'new-backends-read-new-config',
      'independent-window-untouched',
      'saved-history-files-preserved',
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
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    report.checkedAt = new Date().toISOString();
    fs.mkdirSync(path.join(project, 'verification'), { recursive: true });
    fs.writeFileSync(
      path.join(project, 'verification', 'editor-reload.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  }
})();
