'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const cp = require('node:child_process');
const { once } = require('node:events');
const { createUpdateManager } = require('../src/server/update.cjs');
const { performUpdate } = require('../scripts/update-worker.cjs');

const temp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-update-' + name + '-'));
const write = (file, value, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  if (mode) fs.chmodSync(file, mode);
};
const packageTree = (root, files, values) => {
  write(path.join(root, 'release-files.json'), JSON.stringify(files));
  for (const relative of files)
    if (relative !== 'release-files.json')
      write(path.join(root, relative), values?.[relative] || relative);
  for (const dir of ['runtime', 'bin', 'node_modules']) fs.mkdirSync(path.join(root, dir));
};

test('校验和失败时不触碰安装目录', async () => {
  const root = temp('checksum'),
    bridge = path.join(root, 'bridge'),
    target = path.join(root, 'installed');
  fs.mkdirSync(bridge, { recursive: true });
  packageTree(target, ['release-files.json', 'app.txt'], { 'app.txt': 'old' });
  write(path.join(target, 'private', 'keep.txt'), 'private');
  const manager = createUpdateManager({
    bridgeHome: bridge,
    codexHome: path.join(root, 'codex'),
    projectDir: target,
    build: 'aaaaaaaaaaaa',
    version: '0.1.3',
    sequence: 120,
    transport: {
      readJson: async () => ({
        version: '0.1.3',
        build: 'bbbbbbbbbbbb',
        sequence: 128,
        commit: 'c'.repeat(40),
        publishedAt: new Date().toISOString(),
        notes: 'test',
        assets: { 'codex-switcher-windows-x64.zip': 'd'.repeat(64) },
      }),
      download: async (_url, file) => write(file, 'bad archive'),
    },
    extract: async () => assert.fail('校验和失败前不得解压'),
    launchWorker: async () => assert.fail('校验和失败前不得启动替换进程'),
    shutdown: () => assert.fail('校验和失败前不得关闭旧后台'),
    platform: 'win32',
    arch: 'x64',
  });
  await manager.actions.checkUpdate();
  await manager.actions.installUpdate({});
  await manager.finished();
  assert.equal(fs.readFileSync(path.join(target, 'app.txt'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(target, 'private', 'keep.txt'), 'utf8'), 'private');
  assert.match(manager.state().error, /校验和/);
});

test('安装失败后恢复旧文件，保留 private 内容和权限', async () => {
  const root = temp('rollback'),
    bridge = path.join(root, 'bridge'),
    app = process.platform === 'darwin' ? 'Codex Switcher.app/Contents/Resources' : '',
    target = path.join(root, 'installed', app),
    source = path.join(root, 'source', app);
  fs.mkdirSync(path.join(bridge, 'updates'), { recursive: true });
  packageTree(target, ['release-files.json', 'app.txt', 'old.txt'], {
    'app.txt': 'old',
    'old.txt': 'remove-me',
  });
  packageTree(source, ['release-files.json', 'app.txt', 'new.txt'], {
    'app.txt': 'new',
    'new.txt': 'added',
  });
  write(path.join(target, 'private', 'keep.txt'), 'private', 0o600);
  const privateMode = fs.statSync(path.join(target, 'private', 'keep.txt')).mode & 0o777;
  let launched = 0;
  await performUpdate(
    {
      pid: 1,
      source,
      target,
      bridgeHome: bridge,
      codexHome: path.join(root, 'codex'),
      build: 'bbbbbbbbbbbb',
      platform: process.platform,
      arch: process.arch,
    },
    {
      wait: async () => {},
      launchApp: async () => ++launched,
      checkHealth: async () => {
        throw Error('fake health failure');
      },
      stopApp: async () => {},
    },
  );
  assert.equal(launched, 2, '失败后启动新后台并重新启动旧后台');
  assert.equal(fs.readFileSync(path.join(target, 'app.txt'), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(target, 'old.txt')), true);
  assert.equal(fs.existsSync(path.join(target, 'new.txt')), false);
  assert.equal(fs.readFileSync(path.join(target, 'private', 'keep.txt'), 'utf8'), 'private');
  assert.equal(fs.statSync(path.join(target, 'private', 'keep.txt')).mode & 0o777, privateMode);
  assert.match(
    JSON.parse(fs.readFileSync(path.join(bridge, 'updates', 'result.json'))).error,
    /已恢复上一版/,
  );
});

test('升级拒绝外部地址和开发目录', async () => {
  const root = temp('boundary'),
    bridge = path.join(root, 'bridge'),
    project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  const manager = createUpdateManager({
    bridgeHome: bridge,
    codexHome: path.join(root, 'codex'),
    projectDir: project,
    build: 'a'.repeat(12),
    version: '0.1.3',
    platform: 'win32',
    arch: 'x64',
    shutdown: () => {},
  });
  await assert.rejects(
    manager.actions.installUpdate({ url: 'https://example.test' }),
    /不接受地址/,
  );
  await assert.rejects(manager.actions.installUpdate({}), /开发目录/);
});

test('开发目录检查更新时保持 idle 并标记 dev', async () => {
  const root = temp('dev'),
    bridge = path.join(root, 'bridge'),
    project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  const manager = createUpdateManager({
    bridgeHome: bridge,
    codexHome: path.join(root, 'codex'),
    projectDir: project,
    build: 'a'.repeat(12),
    version: '0.1.3',
    platform: 'win32',
    arch: 'x64',
    transport: {
      readJson: async () => ({
        version: '0.1.3',
        build: 'b'.repeat(12),
        sequence: 128,
        commit: 'c'.repeat(40),
        publishedAt: new Date().toISOString(),
        notes: 'test',
        assets: { 'codex-switcher-windows-x64.zip': 'd'.repeat(64) },
      }),
    },
  });
  const state = await manager.actions.checkUpdate();
  assert.equal(state.dev, true);
  assert.equal(state.current.sequence, null);
  assert.equal(state.status, 'idle');
  assert.equal(state.latest.build, 'b'.repeat(12));
});

test('只有更大发行序号可升级，相同或回退序号不下载也不改文件', async () => {
  for (const [sequence, expected] of [
    [128, 'available'],
    [120, 'idle'],
    [119, 'idle'],
  ]) {
    const root = temp('order'),
      target = path.join(root, 'installed');
    write(path.join(target, 'keep.txt'), 'unchanged');
    const manager = createUpdateManager({
      bridgeHome: path.join(root, 'bridge'),
      projectDir: target,
      codexHome: path.join(root, 'codex'),
      version: '0.1.3',
      build: 'a'.repeat(12),
      sequence: 120,
      platform: 'win32',
      arch: 'x64',
      transport: {
        readJson: async () => ({
          version: '0.1.3',
          build: 'b'.repeat(12),
          sequence,
          commit: 'c'.repeat(40),
          publishedAt: new Date().toISOString(),
          notes: 'test',
          assets: { 'codex-switcher-windows-x64.zip': 'd'.repeat(64) },
        }),
        download: async () => assert.fail('相同或回退序号不得下载'),
      },
    });
    const result = await manager.actions.checkUpdate();
    assert.equal(result.status, expected);
    assert.equal(result.current.sequence, 120);
    assert.equal(result.latest.sequence, sequence);
    if (expected === 'idle')
      await assert.rejects(manager.actions.installUpdate({}), /不会安装相同或更旧/);
    assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'unchanged');
  }
});

test('发布序号缺失、非整数或非正数时拒绝元数据', async () => {
  for (const sequence of [undefined, '128', 1.5, 0, -1]) {
    const root = temp('metadata');
    const manager = createUpdateManager({
      bridgeHome: path.join(root, 'bridge'),
      projectDir: path.join(root, 'installed'),
      codexHome: path.join(root, 'codex'),
      version: '0.1.3',
      build: 'a'.repeat(12),
      sequence: 120,
      platform: 'win32',
      arch: 'x64',
      transport: {
        readJson: async () => ({
          version: '0.1.3',
          build: 'b'.repeat(12),
          sequence,
          commit: 'c'.repeat(40),
          publishedAt: new Date().toISOString(),
          notes: 'test',
          assets: { 'codex-switcher-windows-x64.zip': 'd'.repeat(64) },
        }),
      },
    });
    const result = await manager.actions.checkUpdate();
    assert.equal(result.status, 'error');
    assert.match(result.error, /元数据不完整/);
  }
});

test('包内发行序号或构建号与元数据不同，不启动安装且保留原文件', async () => {
  for (const packaged of [
    { sequence: 127, id: 'b'.repeat(12) },
    { sequence: 128, id: 'c'.repeat(12) },
  ]) {
    const root = temp('package-info'),
      target = path.join(root, 'installed');
    write(path.join(target, 'keep.txt'), 'unchanged');
    const payload = 'verified download';
    const manager = createUpdateManager({
      bridgeHome: path.join(root, 'bridge'),
      projectDir: target,
      codexHome: path.join(root, 'codex'),
      version: '0.1.3',
      build: 'a'.repeat(12),
      sequence: 120,
      platform: 'win32',
      arch: 'x64',
      transport: {
        readJson: async () => ({
          version: '0.1.3',
          build: 'b'.repeat(12),
          sequence: 128,
          commit: 'c'.repeat(40),
          publishedAt: new Date().toISOString(),
          notes: 'test',
          assets: {
            'codex-switcher-windows-x64.zip': crypto
              .createHash('sha256')
              .update(payload)
              .digest('hex'),
          },
        }),
        download: async (_url, file) => write(file, payload),
      },
      extract: async (_archive, destination) => {
        packageTree(
          path.join(destination, 'Codex Switcher'),
          ['release-files.json', 'src/platform/build-info.cjs'],
          {
            'src/platform/build-info.cjs': `exports.buildInfo=()=>(${JSON.stringify(packaged)});`,
          },
        );
      },
      launchWorker: async () => assert.fail('包内构建信息不符，不得启动安装'),
      shutdown: () => assert.fail('包内构建信息不符，不得关闭后台'),
    });
    await manager.actions.installUpdate({});
    await manager.finished();
    assert.equal(manager.state().status, 'error');
    assert.match(manager.state().error, packaged.sequence !== 128 ? /发行序号/ : /构建号/);
    assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'unchanged');
  }
});

test('包内构建信息与 release.json 使用同一工作流序号和构建号', () => {
  const root = temp('build'),
    project = path.join(root, 'package'),
    sequence = 321;
  const { buildInfo, releaseInfo } = require('../src/platform/build-info.cjs');
  for (const relative of require('../release-files.json')) {
    write(path.join(project, relative), fs.readFileSync(path.join(__dirname, '..', relative)));
  }
  write(path.join(project, 'src/platform/release-info.json'), releaseInfo(sequence));
  const packaged = JSON.parse(
    cp.execFileSync(
      process.execPath,
      ['-e', "console.log(JSON.stringify(require('./src/platform/build-info.cjs').buildInfo()))"],
      { cwd: project, encoding: 'utf8' },
    ),
  );
  assert.deepEqual(packaged, buildInfo(sequence));
  assert.notEqual(buildInfo(sequence + 1).id, packaged.id, '序号必须参与构建号计算');
  assert.equal(buildInfo().sequence, null, '生成发行元数据不能修改源码占位文件');
  const artifacts = path.join(root, 'artifacts'),
    output = path.join(root, 'release.json');
  write(path.join(artifacts, 'codex-switcher-windows-x64.zip'), 'fixture package');
  cp.execFileSync(
    process.execPath,
    [
      path.join(__dirname, '../scripts/create-release-json.cjs'),
      'v' + require('../package.json').version,
      artifacts,
      output,
    ],
    {
      env: { ...process.env, GITHUB_RUN_NUMBER: String(sequence), GITHUB_SHA: 'c'.repeat(40) },
    },
  );
  const metadata = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(metadata.sequence, packaged.sequence);
  assert.equal(metadata.version, packaged.version);
  assert.equal(metadata.build, packaged.id);
  assert.ok(!metadata.notes.startsWith('#'), '公开摘要使用纯文本');
});

test('更新元数据和资产只从固定仓库latest入口读取，不绑定旧版本', async () => {
  const root = temp('latest'),
    bridge = path.join(root, 'bridge'),
    target = path.join(root, 'installed'),
    urls = [];
  fs.mkdirSync(bridge);
  fs.mkdirSync(target);
  const manager = createUpdateManager({
    bridgeHome: bridge,
    codexHome: path.join(root, 'codex'),
    projectDir: target,
    build: 'a'.repeat(12),
    version: '0.1.4',
    sequence: 1,
    platform: 'win32',
    arch: 'x64',
    transport: {
      readJson: async (url) => {
        urls.push(url);
        return {
          version: '0.1.5',
          build: 'b'.repeat(12),
          sequence: 2,
          commit: 'c'.repeat(40),
          publishedAt: new Date().toISOString(),
          notes: 'fixture future release',
          assets: { 'codex-switcher-windows-x64.zip': 'd'.repeat(64) },
        };
      },
      download: async (url, file) => {
        urls.push(url);
        write(file, 'fixture bad archive');
      },
    },
    extract: async () => assert.fail('错误校验值不能解压'),
  });
  assert.equal((await manager.actions.checkUpdate()).status, 'available');
  await manager.actions.installUpdate({});
  await manager.finished();
  assert.deepEqual(urls, [
    'https://github.com/zengjiahao-1322/codex-switcher-demo/releases/latest/download/release.json',
    'https://github.com/zengjiahao-1322/codex-switcher-demo/releases/latest/download/codex-switcher-windows-x64.zip',
  ]);
  const { REPOSITORY, transportFor } = require('../src/server/update.cjs');
  assert.equal(REPOSITORY, 'zengjiahao-1322/codex-switcher-demo');
  assert.match(transportFor.toString(), /--location/);
  assert.doesNotMatch(transportFor.toString(), /--insecure|['"]-k['"]/);
});

test(
  '真实独立升级进程：本地发行服务 → 下载 → 校验 → 替换 → 新后台健康检查',
  { timeout: 90000 },
  async (t) => {
    const root = temp('complete'),
      bridge = path.join(root, 'private'),
      codex = path.join(root, 'codex'),
      appRelative =
        process.platform === 'win32' ? 'Codex Switcher' : 'Codex Switcher.app/Contents/Resources',
      target = path.join(root, 'installed', appRelative),
      source = path.join(root, 'package', appRelative),
      asset = require('../src/server/update.cjs').assetName(),
      oldBuild = 'aaaaaaaaaaaa',
      newBuild = 'bbbbbbbbbbbb';
    fs.mkdirSync(bridge, { recursive: true });
    fs.mkdirSync(codex);
    write(path.join(bridge, 'accounts', 'keep.txt'), 'account data', 0o600);
    const acl =
      process.platform === 'win32'
        ? cp.execFileSync('icacls.exe', [path.join(bridge, 'accounts', 'keep.txt')], {
            encoding: 'utf8',
          })
        : null;
    const requests = [];
    let metadata, archive;
    const release = http.createServer((req, res) => {
      requests.push(req.url);
      if (req.url === '/release.json') res.end(JSON.stringify(metadata));
      else if (req.url === '/' + asset) res.end(fs.readFileSync(archive));
      else {
        res.writeHead(404);
        res.end();
      }
    });
    release.listen(0, '127.0.0.1');
    await once(release, 'listening');
    t.after(() => release.close());
    const origin = 'http://127.0.0.1:' + release.address().port;
    // 保留真实升级管理器、curl、解压、IPC 和替换进程；只把远端服务与应用业务替换成隔离夹具。
    const files = [
      'release-files.json',
      'main.cjs',
      'src/diagnostics/event-log.cjs',
      'src/server/update.cjs',
      'src/platform/build-info.cjs',
      'src/platform/platform.cjs',
      'src/paths.cjs',
      'scripts/update-worker.cjs',
    ];
    const main = `
    const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
    const {createUpdateManager,transportFor}=require('./src/server/update.cjs');
    const build=require('./src/platform/build-info.cjs').buildInfo();
    const bridge=process.env.BRIDGE_HOME, token=require('node:crypto').randomBytes(16).toString('hex');
    const network=transportFor(process.env.BRIDGE_CODEX_HOME);
    const map=(url)=>${JSON.stringify(origin)}+'/'+url.split('/').pop();
    const manager=createUpdateManager({bridgeHome:bridge,codexHome:process.env.BRIDGE_CODEX_HOME,projectDir:__dirname,version:'0.1.3',build:build.id,sequence:build.sequence,
      transport:{readJson:url=>network.readJson(map(url)),download:(url,file)=>network.download(map(url),file)},
      shutdown:()=>process.exit(0)});
    const server=http.createServer(async(req,res)=>{
      if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);return res.end('{}');}
      try{let value;if(req.url==='/api/runtime')value=build;
      else if(req.url==='/api/state')value={update:manager.state()};
      else if(req.url==='/api/installUpdate')value=await manager.actions.installUpdate({});
      else value=await manager.actions.checkUpdate();
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));}
      catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    });
    server.listen(0,'127.0.0.1',()=>{const url='http://127.0.0.1:'+server.address().port+'/#'+token;
      fs.writeFileSync(path.join(bridge,'running.json'),JSON.stringify({pid:process.pid,url,build}));
      fs.appendFileSync(path.join(bridge,'opened-pages.txt'),url+'\\n');
      console.log('READY');});
    process.on('SIGTERM',()=>process.exit(0));
  `;
    for (const [dir, build] of [
      [target, oldBuild],
      [source, newBuild],
    ]) {
      fs.mkdirSync(dir, { recursive: true });
      write(path.join(dir, 'release-files.json'), JSON.stringify(files));
      for (const file of files.filter(
        (x) => !['release-files.json', 'main.cjs', 'src/platform/build-info.cjs'].includes(x),
      ))
        write(path.join(dir, file), fs.readFileSync(path.join(__dirname, '..', file)));
      write(
        path.join(dir, 'src/platform/build-info.cjs'),
        `exports.buildInfo=()=>({version:'0.1.3',id:'${build}',sequence:${build === oldBuild ? 120 : 128}});`,
      );
      write(path.join(dir, 'main.cjs'), main);
      for (const folder of ['bin', 'node_modules']) fs.mkdirSync(path.join(dir, folder));
      const node = path.join(
        dir,
        'runtime',
        ...(process.platform === 'win32' ? ['node.exe'] : [process.arch, 'node']),
      );
      fs.mkdirSync(path.dirname(node), { recursive: true });
      fs.copyFileSync(process.execPath, node);
      fs.chmodSync(node, 0o755);
    }
    // Windows 便携包的数据目录就在安装目录下，同样不得被替换或备份进程序文件。
    if (process.platform === 'win32')
      write(path.join(target, 'private', 'sentinel'), 'untouched', 0o600);
    archive = path.join(root, asset);
    if (process.platform === 'darwin')
      cp.execFileSync('/usr/bin/ditto', ['-c', '-k', path.join(root, 'package'), archive]);
    else {
      const entries = [];
      const walk = (dir, prefix) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, e.name),
            name = prefix + e.name;
          if (e.isDirectory()) walk(file, name + '/');
          else entries.push({ file, name });
        }
      };
      walk(source, 'Codex Switcher/');
      // 空目录通过哨兵文件进入 ZIP。
      for (const folder of ['bin', 'node_modules']) {
        const file = path.join(source, folder, '.keep');
        write(file, '');
        entries.push({ file, name: 'Codex Switcher/' + folder + '/.keep' });
      }
      require('../src/shared/zip.cjs').zip(entries, archive);
    }
    metadata = {
      version: '0.1.3',
      build: newBuild,
      sequence: 128,
      commit: 'c'.repeat(40),
      publishedAt: new Date().toISOString(),
      notes: 'isolated release',
      assets: {
        [asset]: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
      },
    };
    const child = cp.spawn(process.execPath, [path.join(target, 'main.cjs')], {
      env: {
        ...process.env,
        BRIDGE_HOME: bridge,
        BRIDGE_CODEX_HOME: codex,
        NO_PROXY: '127.0.0.1,localhost',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let running;
    t.after(async () => {
      const pid = fs.existsSync(path.join(bridge, 'running.json'))
        ? JSON.parse(fs.readFileSync(path.join(bridge, 'running.json'))).pid
        : child.pid;
      try {
        process.kill(pid);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      if (child.exitCode === null) child.kill();
    });
    await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('READY')) resolve();
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(Error('fixture exited ' + code)));
    });
    running = JSON.parse(fs.readFileSync(path.join(bridge, 'running.json')));
    const oldUrl = new URL(running.url),
      call = async (name) => {
        const r = await fetch(oldUrl.origin + '/api/' + name, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + oldUrl.hash.slice(1) },
        });
        assert.equal(r.status, 200);
        return r.json();
      };
    assert.equal((await call('checkUpdate')).status, 'available');
    await call('installUpdate');
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      running = JSON.parse(fs.readFileSync(path.join(bridge, 'running.json')));
      if (
        running.build.id === newBuild &&
        fs
          .readFileSync(path.join(bridge, 'logs', 'switcher.log'), 'utf8')
          .includes('"status":"done"')
      )
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(
      running.build.id,
      newBuild,
      fs.existsSync(path.join(bridge, 'updates', 'result.json'))
        ? fs.readFileSync(path.join(bridge, 'updates', 'result.json'), 'utf8')
        : 'new backend did not start',
    );
    const url = new URL(running.url);
    assert.equal(
      (
        await (
          await fetch(url.origin + '/api/runtime', {
            headers: { Authorization: 'Bearer ' + url.hash.slice(1) },
          })
        ).json()
      ).id,
      newBuild,
    );
    assert.notEqual(url.hash, oldUrl.hash, '新后台必须生成新页面令牌');
    assert.equal(
      fs.readFileSync(path.join(bridge, 'opened-pages.txt'), 'utf8').trim().split('\n').length,
      2,
    );
    assert.equal(
      fs.readFileSync(path.join(bridge, 'accounts', 'keep.txt'), 'utf8'),
      'account data',
    );
    if (process.platform === 'win32')
      assert.equal(fs.readFileSync(path.join(target, 'private', 'sentinel'), 'utf8'), 'untouched');
    if (acl)
      assert.equal(
        cp.execFileSync('icacls.exe', [path.join(bridge, 'accounts', 'keep.txt')], {
          encoding: 'utf8',
        }),
        acl,
      );
    assert.deepEqual(requests, ['/release.json', '/' + asset]);
    assert.equal(
      fs.existsSync(
        path.join(
          bridge,
          'updates',
          'previous',
          process.platform === 'win32'
            ? 'main.cjs'
            : 'Codex Switcher.app/Contents/Resources/main.cjs',
        ),
      ),
      true,
    );
  },
);
