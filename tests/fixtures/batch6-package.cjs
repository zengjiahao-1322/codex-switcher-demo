'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http');
const { execFileSync } = require('node:child_process');
const { rustBinary } = require('../backend.cjs');
const { startBackend } = require('../backend-process.cjs');
const asset =
  process.platform === 'win32'
    ? 'codex-switcher-windows-x64.zip'
    : `codex-switcher-macos-${process.arch}.zip`;
const appRelative =
  process.platform === 'win32' ? 'Codex Switcher' : 'Codex Switcher.app/Contents/Resources';
function write(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  if (mode) fs.chmodSync(file, mode);
}
function makePackage(destination, sequence) {
  const entries = require('../../scripts/rust-release.cjs').entries(
    '',
    sequence,
    process.platform,
    process.arch,
    path.dirname(rustBinary()),
  );
  for (const entry of entries) {
    write(
      path.join(destination, entry.name),
      entry.data === undefined ? fs.readFileSync(entry.file) : entry.data,
      entry.mode && entry.mode & 0o777,
    );
  }
  return build(destination);
}
function build(destination) {
  return JSON.parse(
    execFileSync(path.join(destination, path.basename(rustBinary())), ['--build-info'], {
      cwd: destination,
      env: { ...process.env, SWITCHER_WEB_ROOT: path.join(destination, 'web') },
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10000,
    }),
  );
}
function archive(source, out) {
  if (process.platform === 'darwin') {
    execFileSync('/usr/bin/ditto', ['-c', '-k', path.resolve(source, '../../..'), out]);
    return;
  }
  const entries = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), prefix + entry.name + '/');
      else
        entries.push({
          file: path.join(dir, entry.name),
          name: prefix + entry.name,
          mode: fs.statSync(path.join(dir, entry.name)).mode,
        });
    }
  };
  for (const folder of ['runtime', 'bin', 'node_modules'])
    write(path.join(source, folder, '.keep'), '');
  walk(source, 'Codex Switcher/');
  require('../../scripts/lib/zip.cjs').zip(entries, out);
}
function snapshot(directory) {
  const result = {};
  const walk = (dir, prefix = '') => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && entry.name === 'private') continue;
      const file = path.join(dir, entry.name),
        relative = prefix + entry.name;
      if (entry.isDirectory()) walk(file, relative + '/');
      else
        result[relative] = require('node:crypto')
          .createHash('sha256')
          .update(fs.readFileSync(file))
          .digest('hex');
    }
  };
  walk(directory);
  return result;
}
async function until(action, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await action();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error('fixture condition timed out');
}
async function packageFixture(t, options = {}) {
  const requests = [];
  let response = {};
  const release = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/release.json') res.end(JSON.stringify(response.metadata));
    else if (response.cut) {
      res.writeHead(200, { 'content-length': 100000 });
      res.write('partial');
      res.destroy();
    } else if (req.url === '/' + asset && response.archive)
      res.end(fs.readFileSync(response.archive));
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => release.listen(0, '127.0.0.1', r));
  t.after(() => {
    release.closeAllConnections();
    release.close();
  });
  let f, target, current;
  // This runs before backend-process's cleanup so detached replacement processes
  // are stopped while the TEMP package and its executable still exist.
  t.after(async () => {
    if (!f) return;
    const file = path.join(f.bridge, 'running.json');
    if (fs.existsSync(file)) {
      const running = JSON.parse(fs.readFileSync(file));
      if (running.pid !== f.child.pid) {
        try {
          process.kill(running.pid);
        } catch (e) {
          if (e.code !== 'ESRCH') throw e;
        }
        await until(() => {
          try {
            process.kill(running.pid, 0);
            return false;
          } catch (e) {
            return e.code === 'ESRCH';
          }
        }, 5000);
      }
    }
  });
  f = await startBackend(t, {
    setup(context) {
      target = path.join(context.root, 'installed', appRelative);
      current = makePackage(target, options.sequence ?? 100);
      if (options.dev) fs.mkdirSync(path.join(target, '.git'));
      const discovery = path.join(context.root, 'discovery');
      fs.mkdirSync(discovery);
      write(
        path.join(discovery, 'shortcut.json'),
        JSON.stringify({ created: true, sequence: Number.MAX_SAFE_INTEGER }),
      );
      write(
        path.join(process.platform === 'win32' ? target : context.bridge, 'private', 'sentinel'),
        'preserve private',
        0o600,
      );
      write(path.join(context.bridge, 'accounts', 'keep.txt'), 'preserve credentials', 0o600);
      context.environment.SWITCHER_BLACKBOX_PROJECT = target;
      context.environment.SWITCHER_BLACKBOX_EXE = path.join(target, path.basename(rustBinary()));
      context.environment.SWITCHER_WEB_ROOT = path.join(target, 'web');
      context.environment.BRIDGE_DISCOVERY_DIR = discovery;
      context.environment.SWITCHER_TEST_UPDATE_ORIGIN =
        'http://127.0.0.1:' + release.address().port;
      context.environment.NO_PROXY = 'localhost,127.0.0.1';
      context.environment.no_proxy = 'localhost,127.0.0.1';
      options.setup?.(context, target);
    },
  });
  return Object.assign(f, {
    target,
    current,
    requests,
    response,
    asset,
    build,
    makePackage,
    archive,
    write,
    source: () => path.join(f.root, 'package', appRelative),
  });
}
module.exports = {
  packageFixture,
  makePackage,
  archive,
  build,
  snapshot,
  until,
  write,
  asset,
  appRelative,
};
