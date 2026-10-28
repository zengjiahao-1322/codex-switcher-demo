'use strict';
// A standalone external app-server substitute. It imports no switcher code.
// Scenarios and all credentials are synthetic files in each test's TEMP root.
const fs = require('node:fs'),
  path = require('node:path'),
  readline = require('node:readline');
const scenarioFile = process.env.SWITCHER_FAKE_CODEX_SCENARIO;
const scenario = () => JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
const home = fs.realpathSync(process.env.CODEX_HOME);
const initial = scenario();
if (!home.startsWith(fs.realpathSync(initial.root) + path.sep))
  throw Error('Fake app-server home escaped fixture');
const log = path.join(initial.root, 'rpc-' + process.pid + '.jsonl');
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
if (initial.native) {
  // This mode forwards the same transport to a copied official executable.
  // Its only upstream is the test's loopback HTTP server.
  const child = require('node:child_process').spawn(
    initial.native,
    ['-c', 'chatgpt_base_url=' + JSON.stringify(initial.baseUrl), 'app-server'],
    { cwd: home, env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const request = JSON.parse(line);
    fs.appendFileSync(
      log,
      JSON.stringify({
        home,
        method: request.method,
        params: request.params ?? null,
        id: request.id ?? null,
      }) + '\n',
    );
    child.stdin.write(line + '\n');
  });
  lines.once('close', () => {
    child.stdin.end();
    child.kill();
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once('exit', (code) => process.exit(code ?? 1));
  return;
}
const input = readline.createInterface({ input: process.stdin });
input.once('close', () => process.exit(0));
input.on('line', async (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(
    log,
    JSON.stringify({
      home,
      method: request.method,
      params: request.params ?? null,
      id: request.id ?? null,
    }) + '\n',
  );
  if (request.id === undefined) return;
  const config = scenario();
  const profile = config.profiles?.[path.basename(home)] || config;
  const spec = profile.methods?.[request.method] || config.methods?.[request.method];
  if (!spec) {
    emit({ id: request.id, error: { code: -32601, message: 'Fixture method unavailable' } });
    return;
  }
  if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
  if (spec.waitFile)
    while (!fs.existsSync(path.join(config.root, spec.waitFile)))
      await new Promise((r) => setTimeout(r, 10));
  if (spec.auth) fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(spec.auth, null, 2));
  if (spec.exitCode !== undefined) {
    process.exit(spec.exitCode);
    return;
  }
  const notify = async (events) => {
    for (const event of events || []) {
      if (event.delayMs) await new Promise((r) => setTimeout(r, event.delayMs));
      if (event.waitFile)
        while (!fs.existsSync(path.join(config.root, event.waitFile)))
          await new Promise((r) => setTimeout(r, 10));
      if (event.auth)
        fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(event.auth, null, 2));
      emit({ method: event.method, params: event.params });
    }
  };
  await notify(spec.beforeResponse);
  emit({ id: request.id, ...(spec.error ? { error: spec.error } : { result: spec.result ?? {} }) });
  await notify(spec.notifications);
});
