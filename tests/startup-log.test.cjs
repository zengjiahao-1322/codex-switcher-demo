// 启动耗时验收（规格见 COLLAB.md）：真实启动隔离后台，诊断日志里应有 startup 与唯一一条 startup.firstRequest。
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { spawn } = require('node:child_process');

const project = path.join(__dirname, '..');
const ready = fs
  .readFileSync(path.join(project, 'src', 'server', 'main.cjs'), 'utf8')
  .includes("'startup'");

test(
  '启动后记录各阶段耗时；第一个接口请求只记录一次',
  { todo: !ready && '等待 GPT 实现 S' },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-startup-log-'));
    for (const d of ['bridge', 'codex']) fs.mkdirSync(path.join(root, d));
    fs.writeFileSync(path.join(root, 'codex', 'config.toml'), 'model="gpt-5"\n');
    const child = spawn(process.execPath, [path.join(project, 'main.cjs'), '--no-open'], {
      cwd: project,
      env: {
        ...process.env,
        BRIDGE_HOME: path.join(root, 'bridge'),
        BRIDGE_CODEX_HOME: path.join(root, 'codex'),
        BRIDGE_HERMES_HOME: path.join(root, 'none'),
        // CI 为其他测试提供 CODEX_EXE；启动耗时只测服务本身，不应读取该外部路径。
        CODEX_EXE: '',
        // 避开正在使用的 47831，不影响用户本机运行中的切换器。
        BRIDGE_PORT: String(49000 + Math.floor(Math.random() * 9000)),
      },
    });
    const closed = new Promise((resolve) => child.once('close', resolve));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
      fs.rmSync(root, { recursive: true, force: true });
    });
    let errors = '';
    child.stderr.on('data', (d) => (errors += d));
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => String(d).includes('BRIDGE_READY') && resolve());
      // 提前退出时带上子进程的报错和 main-error.log，CI 上才能看出原因。
      child.once('exit', (code) => {
        let fatal = '';
        try {
          fatal = fs.readFileSync(path.join(root, 'bridge', 'main-error.log'), 'utf8');
        } catch {}
        reject(Error('后台提前退出：' + code + '\n' + errors + fatal));
      });
    });
    const { url } = JSON.parse(fs.readFileSync(path.join(root, 'bridge', 'running.json'), 'utf8'));
    const u = new URL(url);
    for (let i = 0; i < 2; i++)
      await fetch(u.origin + '/api/accounts', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + u.hash.slice(1), 'Content-Type': 'application/json' },
        body: '{}',
      }).then((r) => r.text());
    const { readRecent } = require('../src/diagnostics/event-log.cjs');
    const events = readRecent(path.join(root, 'bridge'), 100).filter((e) => e.pid === child.pid);
    const startup = events.find((e) => e.event === 'startup');
    assert.ok(startup, '缺少 startup 事件');
    assert.equal(typeof startup.readyMs, 'number');
    for (const phase of ['existing', 'protectDataDirs', 'createService', 'listen'])
      assert.equal(typeof startup.phases?.[phase], 'number', '缺少阶段耗时：' + phase);
    const first = events.filter((e) => e.event === 'startup.firstRequest');
    assert.equal(first.length, 1, '第一个请求应只记录一次');
    assert.equal(typeof first[0].sinceReadyMs, 'number');
  },
);
