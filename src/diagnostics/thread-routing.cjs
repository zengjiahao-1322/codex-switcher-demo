'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const toml = require('smol-toml');
const { findCodex } = require('../platform/runtime.cjs');

// 只读索引用于确定处理范围；供应商和模型由官方接口持久保存，不改写聊天数据库。
function pendingThreads(home, provider, model) {
  const file = fs
    .readdirSync(home)
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
  if (!file) return [];
  const db = new DatabaseSync(path.join(home, file), { readOnly: true });
  try {
    return db
      .prepare(
        'SELECT id, model_provider, model, rollout_path FROM threads WHERE archived=0 ' +
          'AND source NOT LIKE \'%"subagent"%\' ' +
          'AND (? IS NULL OR model_provider<>? OR model IS NULL OR model<>?) ORDER BY id',
      )
      .all(model || null, provider, model || null);
  } finally {
    db.close();
  }
}

// 只读官方历史中的最近设置；切来源时保留 Codex 为每个对话单独选择的速度。
async function savedServiceTier(file) {
  const setting = (line) => {
    if (!line.includes('"thread_settings_applied"')) return;
    const record = JSON.parse(line.toString('utf8'));
    if (record.type === 'event_msg' && record.payload?.type === 'thread_settings_applied') {
      const settings = record.payload.thread_settings;
      if (settings && Object.hasOwn(settings, 'service_tier'))
        return { tier: settings.service_tier };
    }
  };
  const handle = await fs.promises.open(file, 'r');
  try {
    let position = (await handle.stat()).size,
      remainder = Buffer.alloc(0);
    // 最新设置通常在文件末尾。倒序按块读，找到后立即返回，不扫描整份长对话。
    while (position > 0) {
      const size = Math.min(position, 64 * 1024),
        block = Buffer.allocUnsafe(size);
      position -= size;
      const { bytesRead } = await handle.read(block, 0, size, position);
      const data = Buffer.concat([block.subarray(0, bytesRead), remainder]);
      let end = data.length;
      while (end > 0) {
        const start = data.lastIndexOf(10, end - 1);
        if (start < 0) break;
        // 拼好完整行后才解码，避免块边界切断中文等多字节字符。
        const found = setting(data.subarray(start + 1, end));
        if (found) return found;
        end = start;
      }
      remainder = data.subarray(0, end);
    }
    return setting(remainder);
  } finally {
    await handle.close();
  }
}

function openSession(home, bridgeHome, config, onNotification = () => {}) {
  // 这里只更新会话设置，不发起模型回合，也不启动用户的 MCP、通知或插件。
  const overrides = [
    'notify=[]',
    'analytics.enabled=false',
    'features.plugins=false',
    'features.remote_plugin=false',
    'features.codex_hooks=false',
  ];
  // Codex 的 -c 路径按点分段，不能给简单键额外加引号，否则会生成一个错误的新 MCP 项。
  for (const name of Object.keys(config.mcp_servers || {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw Error('暂不支持此 MCP 配置名称：' + name);
    overrides.push('mcp_servers.' + name + '.enabled=false');
  }
  const child = spawn(
    findCodex({ dataHome: bridgeHome }),
    [...overrides.flatMap((value) => ['-c', value]), 'app-server'],
    {
      cwd: home,
      env: require('../platform/platform.cjs').codexEnv(home),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let seq = 0,
    buffer = '',
    stopped;
  const pending = new Map();
  const fail = (error) => {
    stopped = error;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', () => fail(Error('Codex 会话设置服务已退出。')));
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        continue;
      }
      if (reply.id === undefined) {
        onNotification(reply);
        continue;
      }
      const item = pending.get(reply.id);
      if (!item) continue;
      clearTimeout(item.timer);
      pending.delete(reply.id);
      if (reply.error) item.reject(Error(reply.error.message));
      else item.resolve(reply.result);
    }
  });
  return {
    call(method, params) {
      if (stopped) return Promise.reject(stopped);
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error('更新旧对话超时：' + method));
        }, 30000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode) return;
      await new Promise((resolve) => {
        const timer = setTimeout(() => child.kill(), 2000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.stdin.end();
      });
    },
  };
}

async function synchronizeThreads({
  codexHome,
  bridgeHome,
  mode = 'all',
  previousProvider,
  targetModels,
  onProgress = () => {},
}) {
  const counts = { updated: 0, skipped: 0, failed: 0 };
  if (mode === 'off') return counts;
  const config = toml.parse(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
  const provider = config.model_provider || 'openai';
  if (!fs.readdirSync(codexHome).some((name) => /^state_\d+\.sqlite$/.test(name))) return counts;
  let client = openSession(codexHome, bridgeHome, config);
  const initialize = () =>
    client.call('initialize', {
      clientInfo: { name: 'codex-switcher-routing', version: '1' },
      capabilities: { experimentalApi: true },
    });
  let rows = [];
  try {
    await initialize();
    // 先由官方后端恢复 WAL，再读索引；只筛选未归档的用户对话。
    rows = pendingThreads(codexHome, provider).filter((row) => {
      if (mode === 'matching' && row.model_provider !== previousProvider) {
        counts.skipped++;
        return false;
      }
      return true;
    });
    if (!rows.length) return counts;
    let models = targetModels,
      model = config.model;
    if (!models?.length && config.model_catalog_json) {
      const catalog = JSON.parse(
        fs.readFileSync(path.resolve(codexHome, config.model_catalog_json), 'utf8'),
      );
      models = catalog.models.map((item) => item.slug);
    }
    if (!models?.length || !model) {
      const { data } = await client.call('model/list', {});
      if (!models?.length) models = data.map((item) => item.model);
      model ||= data.find((item) => item.isDefault)?.model || data[0]?.model;
    }
    if (!model) throw Error('未找到目标来源的默认模型，旧对话未更新。');
    rows = rows.filter((row) => {
      row.nextModel = row.model && models.includes(row.model) ? row.model : model;
      if (row.model_provider === provider && row.model === row.nextModel) {
        counts.skipped++;
        return false;
      }
      return true;
    });
    if (!rows.length) return counts;
    const processRows = async (batch, phase, action) => {
      let next = 0,
        completed = 0,
        failure;
      onProgress({ completed, total: batch.length, phase });
      // 共用一个官方后端、最多四条在途；失败后停止派发，等待在途任务收尾。
      await Promise.all(
        Array.from({ length: Math.min(4, batch.length) }, async () => {
          while (!failure && next < batch.length) {
            const row = batch[next++];
            try {
              await action(row);
              onProgress({ completed: ++completed, total: batch.length, phase });
            } catch (error) {
              failure ??= error;
            }
          }
        }),
      );
      return failure;
    };
    const failure = await processRows(rows, 'sync', async (row) => {
      row.speed = await savedServiceTier(row.rollout_path);
      let result;
      try {
        result = await client.call('thread/resume', {
          threadId: row.id,
          modelProvider: provider,
          model: row.nextModel,
          ...(row.speed ? { serviceTier: row.speed.tier ?? '' } : {}),
          excludeTurns: true,
        });
      } catch (error) {
        if (/active writer/.test(error.message))
          throw Error('旧对话 ' + row.id + ' 仍被客户端占用，请关闭该客户端后继续同步。');
        throw error;
      }
      if (result.modelProvider !== provider || result.model !== row.nextModel)
        throw Error('旧对话 ' + row.id + ' 未采用目标来源或模型。');
      if (row.speed && result.serviceTier !== row.speed.tier)
        throw Error('旧对话 ' + row.id + ' 的原有速度设置未保留。');
      row.applied = true;
      await client.call('thread/unsubscribe', { threadId: row.id });
    });
    await client.close();
    // 部分失败时也冷启动核对已更新的对话，准确报告实际完成条数。
    client = openSession(codexHome, bridgeHome, config);
    await initialize();
    const verifyFailure = await processRows(
      rows.filter((row) => row.applied),
      'verify',
      async (row) => {
        const [{ thread }, savedSpeed] = await Promise.all([
          client.call('thread/read', {
            threadId: row.id,
            includeTurns: false,
          }),
          row.speed ? savedServiceTier(row.rollout_path) : Promise.resolve(null),
        ]);
        if (thread.modelProvider !== provider || thread.model !== row.nextModel)
          throw Error('旧对话 ' + row.id + ' 的来源或模型未能持久保存。');
        if (row.speed && savedSpeed?.tier !== row.speed.tier)
          throw Error('旧对话 ' + row.id + ' 的速度设置未能持久保留。');
        counts.updated++;
      },
    );
    if (failure || verifyFailure) throw failure || verifyFailure;
    return counts;
  } catch (error) {
    counts.failed = rows.length - counts.updated;
    error.threads = counts;
    throw error;
  } finally {
    await client.close();
  }
}

module.exports = { synchronizeThreads, pendingThreads, openSession, savedServiceTier };
