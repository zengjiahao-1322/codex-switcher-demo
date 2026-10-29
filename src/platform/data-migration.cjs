'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { writeJson, readJson } = require('../accounts/accounts.cjs');
const providers = require('../config/providers.cjs');
const events = require('../diagnostics/event-log.cjs');
const usesDefault = (project) =>
  process.platform === 'win32' &&
  (!process.env.BRIDGE_HOME ||
    path.resolve(process.env.BRIDGE_HOME).toLowerCase() ===
      path.resolve(project, 'private').toLowerCase());
function copy(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
    filter(file) {
      if (fs.lstatSync(file).isSymbolicLink()) throw Error('旧数据目录包含链接，未迁移：' + file);
      return true;
    },
  });
}
function prepare(project, bridge) {
  if (!usesDefault(project) || fs.existsSync(path.join(bridge, 'migrated.json'))) return false;
  const source = path.join(project, 'private');
  if ((!fs.existsSync(bridge) || !fs.readdirSync(bridge).length) && fs.existsSync(source)) {
    copy(source, bridge);
    return true;
  }
  return false;
}
function summary(bridge) {
  const result = readJson(path.join(bridge, 'migrated.json'));
  return result
    ? { folders: result.folders, accounts: result.accounts, apis: result.apis, at: result.at }
    : null;
}
function merge(source, bridge) {
  const index = path.join(bridge, 'accounts/index.json');
  const rows = readJson(index, []);
  let accounts = 0;
  const accountIds = [];
  for (const row of readJson(path.join(source, 'accounts/index.json'), [])) {
    // IDs and folders come from another installation, so keep paths inside accounts/.
    if (!/^[a-zA-Z0-9_-]+$/.test(row.id)) throw Error('旧副本中的账号 ID 无效');
    const oldAt = rows.findIndex((old) => old.id === row.id);
    const sourceDir = path.join(source, 'accounts', row.id);
    const targetDir = path.join(bridge, 'accounts', row.id);
    const auth = readJson(path.join(sourceDir, 'auth.json'));
    const previous = readJson(path.join(targetDir, 'auth.json'));
    const refreshed = (item, credential) =>
      Date.parse(item?.lastRefresh || credential?.last_refresh || '') || 0;
    if (oldAt >= 0 && refreshed(row, auth) <= refreshed(rows[oldAt], previous)) continue;
    copy(sourceDir, targetDir);
    if (oldAt < 0) rows.push(row);
    else rows[oldAt] = row;
    accounts++;
    accountIds.push(row.id);
  }
  if (accounts) writeJson(index, rows);
  const current = providers.load(bridge);
  let apis = 0;
  for (const provider of providers.load(source).providers) {
    const old = current.providers.find((p) => p.id === provider.id);
    if (old && isDeepStrictEqual(old, provider)) continue;
    const imported = { ...provider };
    if (old) {
      imported.id = crypto
        .createHash('sha256')
        .update(source + '\0' + provider.id)
        .digest('hex')
        .slice(0, 20);
      imported.name += '（来自旧副本）';
      if (current.providers.some((p) => p.id === imported.id)) continue;
    }
    current.providers.push(imported);
    apis++;
  }
  if (apis) providers.save(bridge, current);
  return { path: source, accounts, apis, accountIds };
}
function start(project, bridge, copiedLocal) {
  if (!usesDefault(project) || fs.existsSync(path.join(bridge, 'migrated.json'))) return;
  const started = performance.now();
  let mergeCpuMs = 0;
  const sources = [];
  const accountIds = new Set();
  if (copiedLocal) {
    const source = path.join(project, 'private');
    sources.push({
      path: source,
      accounts: readJson(path.join(source, 'accounts/index.json'), []).length,
      apis: providers.load(source).providers.length,
    });
    for (const row of readJson(path.join(source, 'accounts/index.json'), []))
      accountIds.add(row.id);
  }
  const worker = cp.fork(__filename, ['--scan', project, bridge], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let complete = false;
  let errorText = '';
  worker.stderr.on('data', (chunk) => {
    errorText += chunk;
  });
  worker.on('message', (message) => {
    if (message.source) {
      const cpu = process.cpuUsage();
      try {
        const { accountIds: imported, ...source } = merge(message.source, bridge);
        for (const id of imported) accountIds.add(id);
        sources.push(source);
      } catch (error) {
        sources.push(
          events.redact({
            path: message.source,
            failed: true,
            error: error.message,
            accounts: 0,
            apis: 0,
          }),
        );
      }
      const used = process.cpuUsage(cpu);
      mergeCpuMs += (used.user + used.system) / 1000;
    } else if (message.done) {
      const result = {
        completed: true,
        at: new Date().toISOString(),
        copiedLocal,
        folders: sources.filter((source) => !source.failed).length,
        accounts: accountIds.size,
        apis: sources.reduce((n, s) => n + s.apis, 0),
        durationMs: performance.now() - started,
        cpuMs: message.cpuMs + mergeCpuMs,
        skipped: message.skipped,
        sources,
      };
      writeJson(path.join(bridge, 'migrated.json'), result);
      events.log(bridge, 'data.migrate', result);
      complete = true;
    }
  });
  worker.on('error', (error) => {
    errorText = error.message;
  });
  worker.on('close', (code) => {
    if (!complete)
      events.log(bridge, 'data.migrate', { error: errorText || '迁移扫描未完成：' + code });
  });
}
async function scan(project, bridge) {
  os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
  const cpu = process.cpuUsage();
  const roots = process.env.SWITCHER_TEST_MIGRATION_ROOTS
    ? JSON.parse(process.env.SWITCHER_TEST_MIGRATION_ROOTS)
    : JSON.parse(
        cp.execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "ConvertTo-Json -Compress -InputObject @((Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3').DeviceID | ForEach-Object { $_ + '\\' })",
          ],
          { encoding: 'utf8', windowsHide: true },
        ),
      );
  const stack = roots.map((root) => [path.resolve(root), 0]);
  let skipped = 0;
  while (stack.length) {
    const [directory, depth] = stack.pop();
    if (directory.toLowerCase() === path.resolve(bridge).toLowerCase()) continue;
    let entries;
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) {
        skipped++;
        continue;
      }
      throw error;
    }
    if (
      fs.existsSync(path.join(directory, 'private/accounts/index.json')) &&
      directory.toLowerCase() !== path.resolve(project).toLowerCase()
    ) {
      const file = path.join(directory, 'package.json');
      if (
        fs.existsSync(file) &&
        JSON.parse(await fs.promises.readFile(file, 'utf8')).name === 'codex-api-switcher'
      ) {
        process.send({ source: path.join(directory, 'private') });
        continue;
      }
    }
    if (depth >= 9) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = path.join(directory, entry.name);
      if (
        /^(windows|program files.*|programdata|\$recycle\.bin|node_modules|\.git)$/i.test(
          entry.name,
        ) ||
        /(?:^|[\\/])appdata[\\/]local[\\/]temp$/i.test(child)
      ) {
        skipped++;
        continue;
      }
      stack.push([child, depth + 1]);
    }
  }
  const used = process.cpuUsage(cpu);
  process.send({ done: true, skipped, cpuMs: (used.user + used.system) / 1000 });
  process.disconnect();
}
if (process.argv[2] === '--scan') {
  process.on('disconnect', () => process.exit());
  scan(process.argv[3], process.argv[4]).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
module.exports = { prepare, start, summary, usesDefault };
