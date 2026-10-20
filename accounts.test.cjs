'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  { spawn } = require('node:child_process'),
  toml = require('smol-toml');
const { createAccounts, identity, writeJson } = require('./accounts.cjs'),
  { runSwitch } = require('./desktop-account.cjs');
const jwt = (payload) =>
  'fixture.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.signature';
function auth(user, refresh = 'refresh-' + user, account = 'workspace-' + user) {
  return {
    auth_mode: 'chatgpt',
    tokens: {
      account_id: account,
      access_token: jwt({
        'https://api.openai.com/auth': { chatgpt_user_id: user, chatgpt_plan_type: 'plus' },
      }),
      id_token: jwt({ email: user + '@example.test' }),
      refresh_token: refresh,
    },
    last_refresh: new Date().toISOString(),
  };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-accounts-')),
    codexHome = path.join(root, 'codex'),
    bridgeHome = path.join(root, 'bridge');
  fs.mkdirSync(codexHome);
  fs.mkdirSync(bridgeHome);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, codexHome, bridgeHome };
}
function configured(t) {
  const f = fixture(t);
  writeJson(path.join(f.codexHome, 'auth.json'), auth('alice'));
  fs.writeFileSync(
    path.join(f.codexHome, 'config.toml'),
    'model="official"\n[mcp_servers.keep]\ncommand="keep"\n',
  );
  return f;
}

test('account list captures current login, distinguishes workspaces, and never returns credentials', (t) => {
  const f = configured(t),
    a = createAccounts(f);
  let s = a.status();
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].email, 'alice@example.test');
  assert.equal(s.items[0].current, true);
  assert.equal(JSON.stringify(s).includes('refresh-alice'), false);
  assert.equal(JSON.stringify(s).includes('access_token'), false);
  const aliceId = s.items[0].id;
  a.rename(aliceId, '主账号');
  assert.equal(a.status().items[0].label, '主账号');
  writeJson(path.join(f.codexHome, 'auth.json'), auth('alice', 'new-refresh', 'workspace-team'));
  s = a.status();
  assert.equal(s.items.length, 2);
  assert.notEqual(s.items[0].id, s.items[1].id);
  assert.equal(s.items.filter((x) => x.current).length, 1);
  a.remove(aliceId);
  assert.equal(a.status().items.length, 1);
});

test('switch waits for desktop exit, preserves refreshed outgoing credentials, and restores official model/catalog', async (t) => {
  const f = configured(t),
    a = loginFixture(f);
  const alice = a.status().items[0];
  writeJson(path.join(f.codexHome, 'auth.json'), auth('bob'));
  const bob = a.status().items.find((x) => x.current);
  a.rename(bob.id, '备用账号');
  writeJson(path.join(f.codexHome, 'auth.json'), auth('alice'));
  fs.writeFileSync(
    path.join(f.codexHome, 'config.toml'),
    'model="custom"\nmodel_provider="hermes_bridge"\nmodel_catalog_json="C:/bridge-models.json"\n[mcp_servers.keep]\ncommand="keep"\n[model_providers.hermes_bridge]\nbase_url="http://localhost:1/v1"\nrequires_openai_auth=false\n',
  );
  const events = [];
  await runSwitch(
    { ...f, id: bob.id, model: 'official', desktopExe: 'fixture-desktop.exe' },
    {
      accounts: a,
      syncThreads: async () => {
        events.push('sync');
        return { count: 2, provider: 'openai', model: 'official' };
      },
      stop: async () => {
        events.push('stop');
        writeJson(path.join(f.codexHome, 'auth.json'), auth('alice', 'REFRESHED_BEFORE_EXIT'));
      },
      open: async () => {
        events.push('open');
        assert.equal(
          identity(JSON.parse(fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8'))).id,
          bob.id,
        );
      },
    },
  );
  assert.deepEqual(events, ['stop', 'sync', 'open']);
  assert.equal(a.status().switchJob.threadRouting.count, 2);
  const c = toml.parse(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'));
  assert.equal(c.model, 'official');
  assert.equal(c.model_provider, undefined);
  assert.equal(c.model_catalog_json, undefined);
  assert.equal(c.mcp_servers.keep.command, 'keep');
  assert.ok(c.model_providers.hermes_bridge);
  assert.equal(a.status().items.find((x) => x.current).id, bob.id);
  a.apply(alice.id, 'official');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8')).tokens.refresh_token,
    'REFRESHED_BEFORE_EXIT',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.bridgeHome, 'account-switch.json'), 'utf8')).status,
    'done',
  );
});

function loginFixture(f, { cancel = false, loginUser = 'new-user', failPrepare = false } = {}) {
  const fake = path.join(f.root, 'fake-app-server.cjs');
  fs.writeFileSync(
    fake,
    `const fs=require('fs'),path=require('path'),rl=require('readline');const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='account/read'){const file=path.join(process.env.CODEX_HOME,'auth.json');if(${failPrepare}){send({id:m.id,error:{code:401,message:'fixture rejected'}});return}const auth=JSON.parse(fs.readFileSync(file));auth.tokens.refresh_token+='-prepared';fs.writeFileSync(file,JSON.stringify(auth));send({id:m.id,result:{account:{type:'chatgpt',email:'fixture@example.test'}}});return}if(m.method==='initialize')send({id:m.id,result:{}});if(m.method==='account/login/start'){send({id:m.id,result:{type:'chatgpt',loginId:'fixture-login',authUrl:'https://auth.openai.com/fixture-login'}});${cancel ? '' : `setTimeout(()=>{fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),${JSON.stringify(JSON.stringify(auth(loginUser)))});send({method:'account/login/completed',params:{loginId:'fixture-login',success:true,error:null}})},50);`}}if(m.method==='account/login/cancel'){send({id:m.id,result:{status:'canceled'}});send({method:'account/login/completed',params:{loginId:'fixture-login',success:false,error:'cancelled'}})}});`,
  );
  return createAccounts({
    ...f,
    codexExe: process.execPath,
    spawnProcess: (_exe, args, options) => spawn(process.execPath, [fake, ...args], options),
  });
}
test('official login completion adds the new account without changing the active desktop login', async (t) => {
  const f = configured(t),
    a = loginFixture(f),
    before = fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8');
  const start = await a.startLogin();
  assert.equal(start.status, 'waiting');
  assert.equal(start.authUrl, 'https://auth.openai.com/fixture-login');
  const until = Date.now() + 5000;
  while (a.status().login.status === 'waiting' && Date.now() < until)
    await new Promise((r) => setTimeout(r, 20));
  const s = a.status();
  assert.equal(s.login.status, 'done');
  assert.equal(s.items.length, 2);
  assert.equal(s.items.find((x) => x.current).email, 'alice@example.test');
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.bridgeHome, 'accounts/login/auth.json')), false);
  assert.equal(JSON.stringify(s).includes('refresh-new-user'), false);
});
test('canceling an official login leaves saved and active accounts intact', async (t) => {
  const f = configured(t),
    a = loginFixture(f, { cancel: true });
  await a.startLogin();
  await a.cancelLogin();
  assert.equal(a.status().login.status, 'cancelled');
  assert.equal(a.status().items.length, 1);
});

test('missing runtime leaves login retryable and reports the real quota failure', async (t) => {
  const f = configured(t),
    a = createAccounts({
      ...f,
      codexExe: () => {
        throw Object.assign(Error('fixture runtime missing'), { code: 'CODEX_NOT_FOUND' });
      },
    });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(a.startLogin(), /fixture runtime missing/);
    assert.equal(a.status().login.status, 'error');
  }
  const id = a.status().items[0].id,
    result = await a.quota(id);
  assert.equal(result.error, 'fixture runtime missing');
  assert.equal(result.status, 'error');
});

test('IDE-only official switch works with no desktop, model or model cache', async (t) => {
  const f = configured(t),
    a = createAccounts(f),
    id = a.status().items[0].id;
  fs.writeFileSync(
    path.join(f.codexHome, 'config.toml'),
    'model="api-model"\nmodel_provider="hermes_bridge"\n[mcp_servers.keep]\ncommand="keep"\n',
  );
  await runSwitch(
    { ...f, id, desktopExe: null, reloadEditors: false },
    {
      accounts: a,
      stop: () => assert.fail('must not stop desktop'),
      open: () => assert.fail('must not open desktop'),
    },
  );
  const c = toml.parse(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'));
  assert.equal(c.model, undefined);
  assert.equal(c.model_provider, undefined);
  assert.equal(c.mcp_servers.keep.command, 'keep');
  assert.equal(a.status().switchJob.status, 'done');
});

test('old-thread synchronization failure is not reported as a completed switch', async (t) => {
  const f = configured(t),
    a = loginFixture(f),
    id = a.status().items[0].id;
  await assert.rejects(
    runSwitch(
      { ...f, id, model: 'official', desktopExe: 'fixture-desktop.exe' },
      {
        accounts: a,
        stop: async () => {},
        open: async () => assert.fail('must not reopen before thread synchronization succeeds'),
        syncThreads: async () => {
          throw Error('fixture active writer');
        },
      },
    ),
    /fixture active writer/,
  );
  assert.equal(a.status().switchJob.status, 'error');
  assert.equal(
    require('./switch-state.cjs').readEffect(f.codexHome, f.bridgeHome).status,
    'switch_incomplete',
  );
});

test('quota requests deduplicate only the same account and publish each result independently', async (t) => {
  const f = configured(t),
    started = [];
  let releaseSlow;
  const slow = new Promise((resolve) => {
      releaseSlow = resolve;
    }),
    fake = path.join(f.root, 'quota-server.cjs');
  fs.writeFileSync(
    fake,
    `require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);const send=result=>process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');if(m.method==='initialize')send({});if(m.method==='account/read')send({account:{type:'chatgpt'}});if(m.method==='account/rateLimits/read')send({rateLimits:{primary:{usedPercent:25,windowDurationMins:300}}})});`,
  );
  const a = createAccounts({
    ...f,
    codexExe: process.execPath,
    spawnProcess: (_exe, args, options) => {
      started.push(options.cwd);
      const p = spawn(process.execPath, [fake, ...args], options);
      if (options.cwd.includes(identity(auth('alice')).id)) {
        const write = p.stdin.write.bind(p.stdin);
        p.stdin.write = (data, ...rest) => {
          if (data.includes('rateLimits/read')) {
            slow.then(() => write(data, ...rest));
            return true;
          }
          return write(data, ...rest);
        };
      }
      return p;
    },
  });
  const alice = a.status().items[0];
  writeJson(path.join(f.codexHome, 'auth.json'), auth('bob'));
  const bob = a.status().items.find((x) => x.current);
  const first = a.quota(alice.id);
  assert.equal(a.quota(alice.id), first);
  t.after(releaseSlow);
  const second = await a.quota(bob.id);
  assert.equal(second.status, 'ok');
  assert.equal(second.buckets[0].windows[0].remainingPercent, 75);
  assert.equal(started.length, 2);
  assert.equal(a.status().items.find((x) => x.id === alice.id).quota, null);
  releaseSlow();
  assert.equal((await first).status, 'ok');
});

test('older live auth does not replace the refreshed saved login', (t) => {
  const f = configured(t),
    a = createAccounts(f),
    row = a.status().items[0];
  const older = auth('alice', 'old-refresh');
  older.last_refresh = '2026-01-01T00:00:00Z';
  writeJson(path.join(f.codexHome, 'auth.json'), older);
  const refreshed = auth('alice', 'fresh-refresh');
  refreshed.last_refresh = '2026-01-02T00:00:00Z';
  writeJson(path.join(f.bridgeHome, 'accounts', row.id, 'auth.json'), refreshed);
  a.status();
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.bridgeHome, 'accounts', row.id, 'auth.json'))).tokens
      .refresh_token,
    'fresh-refresh',
  );
  older.last_refresh = '2026-01-03T00:00:00Z';
  writeJson(path.join(f.codexHome, 'auth.json'), older);
  a.status();
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.bridgeHome, 'accounts', row.id, 'auth.json'))).tokens
      .refresh_token,
    'old-refresh',
  );
});

test('applying a saved account selects file credentials instead of a different keyring identity', (t) => {
  const f = configured(t),
    a = createAccounts(f),
    id = a.status().items[0].id;
  fs.writeFileSync(
    path.join(f.codexHome, 'config.toml'),
    'model="official"\ncli_auth_credentials_store="keyring"\n[mcp_servers.keep]\ncommand="keep"\n',
  );
  a.apply(id, 'official');
  const config = toml.parse(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'));
  assert.equal(config.cli_auth_credentials_store, 'file');
  assert.equal(config.mcp_servers.keep.command, 'keep');
  assert.equal(identity(JSON.parse(fs.readFileSync(path.join(f.codexHome, 'auth.json')))).id, id);
});

async function waitLogin(a) {
  const end = Date.now() + 5000;
  while (a.status().login?.status === 'waiting' && Date.now() < end)
    await new Promise((r) => setTimeout(r, 20));
  return a.status();
}
test('reauthentication updates the same account without old live auth overwriting it', async (t) => {
  const f = configured(t),
    a = loginFixture(f, { loginUser: 'alice' }),
    row = a.status().items[0];
  a.rename(row.id, '主账号');
  const before = fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8');
  await a.startLogin({ id: row.id });
  let s = await waitLogin(a);
  assert.equal(s.login.status, 'done');
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].id, row.id);
  assert.equal(s.items[0].label, '主账号');
  assert.equal(s.items[0].pendingLogin, true);
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8'), before);
  const saved = fs.readFileSync(path.join(f.bridgeHome, 'accounts', row.id, 'auth.json'), 'utf8');
  a.status();
  assert.equal(
    fs.readFileSync(path.join(f.bridgeHome, 'accounts', row.id, 'auth.json'), 'utf8'),
    saved,
  );
  a.apply(row.id, 'official');
  assert.equal(a.status().items[0].pendingLogin, false);
  const wrong = loginFixture(f, { loginUser: 'other' });
  await wrong.startLogin({ id: row.id });
  s = await waitLogin(wrong);
  assert.equal(s.login.status, 'error');
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].id, row.id);
});

test('preparation failure preserves the running desktop and active configuration', async (t) => {
  const f = configured(t),
    a = loginFixture(f, { failPrepare: true });
  a.status();
  writeJson(path.join(f.codexHome, 'auth.json'), auth('bob'));
  const bob = a.status().items.find((x) => x.current);
  writeJson(path.join(f.codexHome, 'auth.json'), auth('alice'));
  const authBefore = fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8'),
    configBefore = fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8');
  let stopped = false;
  await assert.rejects(
    runSwitch(
      { ...f, id: bob.id, model: 'official' },
      {
        accounts: a,
        stop: async () => {
          stopped = true;
        },
        open: async () => assert.fail('must not open'),
      },
    ),
    /未关闭桌面端/,
  );
  assert.equal(stopped, false);
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8'), authBefore);
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'), configBefore);
  assert.equal(a.status().switchJob.status, 'error');
});

test('a second service cannot mutate configuration throughout background preparation and reopening', async (t) => {
  const f = configured(t),
    a = loginFixture(f),
    op = require('./switch-state.cjs');
  a.status();
  writeJson(path.join(f.codexHome, 'auth.json'), auth('bob'));
  const bob = a.status().items.find((x) => x.current);
  writeJson(path.join(f.codexHome, 'auth.json'), auth('alice'));
  const { createService } = require('./service.cjs'),
    other = createService(f);
  let continuePrepare;
  const gate = new Promise((r) => {
    continuePrepare = r;
  });
  op.acquire(f.bridgeHome);
  const task = runSwitch(
    { ...f, id: bob.id, model: 'official' },
    {
      accounts: {
        ...a,
        prepare: async (id) => {
          await gate;
          return a.prepare(id);
        },
      },
      stop: async () => {},
      open: async () => {
        assert.equal(a.status().switchJob.status, 'reopening');
        await assert.rejects(
          other.actions.accountRename({ id: bob.id, label: 'blocked' }),
          /切换正在进行/,
        );
      },
    },
  );
  assert.equal(a.status().switchJob.status, 'preparing');
  await assert.rejects(other.actions.switch({ id: 'official', model: 'other' }), /切换正在进行/);
  await assert.rejects(other.actions.providerAdd({ name: 'blocked' }), /切换正在进行/);
  continuePrepare();
  await task;
  assert.equal(fs.existsSync(path.join(f.bridgeHome, 'operation.lock')), false);
  assert.equal((await other.state()).effect.status, 'reopen_requested');
  await other.actions.accountRename({ id: bob.id, label: 'allowed' });
  assert.equal(a.status().items.find((x) => x.id === bob.id).label, 'allowed');
});

test('API desktop switch prepares before closing, applies after closing, and allows retry after reopen failure', async (t) => {
  const f = configured(t),
    http = require('node:http'),
    store = require('./providers.cjs'),
    op = require('./switch-state.cjs');
  const upstream = http.createServer((q, r) => {
    r.setHeader('content-type', 'application/json');
    r.end(
      JSON.stringify(
        q.url.endsWith('/models')
          ? { data: [{ id: 'api-model' }] }
          : {
              object: 'response',
              status: 'completed',
              output: [{ type: 'function_call', name: 'bridge_ping' }],
            },
      ),
    );
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());
  const id = store.add(f.bridgeHome, {
    name: 'API fixture',
    baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1',
    apiMode: 'responses',
    apiKey: 'fixture-key',
    model: 'api-model',
  });
  const cache = path.join(os.homedir(), '.codex', 'models_cache.json');
  if (fs.existsSync(cache)) fs.copyFileSync(cache, path.join(f.codexHome, 'models_cache.json'));
  const authBefore = fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8'),
    configBefore = fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8');
  const catalogFile = path.join(f.bridgeHome, 'model-catalog.json');
  fs.writeFileSync(catalogFile, '{"models":[]}');
  let stopped = false;
  const job = { ...f, id, kind: 'api', model: 'api-model' };
  await runSwitch(job, {
    stop: async () => {
      assert.equal(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'), configBefore);
      assert.equal(fs.readFileSync(catalogFile, 'utf8'), '{"models":[]}');
      assert.equal(store.access(f.bridgeHome, store.list(f.bridgeHome)[0]).mode, 'direct');
      stopped = true;
    },
    open: async () => {
      assert.equal(stopped, true);
      assert.equal(
        toml.parse(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8')).model,
        'api-model',
      );
      assert.equal(fs.readFileSync(path.join(f.codexHome, 'auth.json'), 'utf8'), authBefore);
    },
  });
  assert.equal(op.switchJob(f.bridgeHome).status, 'done');
  assert.equal(op.readEffect(f.codexHome, f.bridgeHome).status, 'reopen_requested');
  await assert.rejects(
    runSwitch(job, {
      stop: async () => {},
      open: async () => {
        throw Error('fixture reopen failed');
      },
    }),
    /fixture reopen failed/,
  );
  assert.equal(op.readEffect(f.codexHome, f.bridgeHome).status, 'switch_incomplete');
  assert.match(
    op.switchJob(f.bridgeHome).message,
    /配置已应用，但旧对话同步或客户端重新加载未完成/,
  );
  await runSwitch(job, { stop: async () => {}, open: async () => {} });
  assert.equal(op.switchJob(f.bridgeHome).status, 'done');
  assert.equal(
    fs.readdirSync(f.bridgeHome).some((n) => n.endsWith('.prepared')),
    false,
  );
});

test('rejected API preparation leaves desktop, config and model catalog untouched', async (t) => {
  const f = configured(t),
    http = require('node:http'),
    store = require('./providers.cjs');
  const upstream = http.createServer((q, r) => {
    r.writeHead(401);
    r.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());
  const id = store.add(f.bridgeHome, {
    name: 'Rejected',
    baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1',
    apiMode: 'responses',
    apiKey: 'fixture-key',
    model: 'api-model',
  });
  const before = fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8');
  await assert.rejects(
    runSwitch(
      { ...f, id, kind: 'api', model: 'api-model' },
      {
        stop: async () => assert.fail('must not close desktop'),
        open: async () => assert.fail('must not reopen'),
      },
    ),
    /检测未通过/,
  );
  assert.equal(fs.readFileSync(path.join(f.codexHome, 'config.toml'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.bridgeHome, 'model-catalog.json')), false);
});
