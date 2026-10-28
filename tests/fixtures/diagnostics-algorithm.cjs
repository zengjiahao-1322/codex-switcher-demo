'use strict';
const fs = require('node:fs');
const { redact, log, readRecent } = require('../../src/diagnostics/event-log.cjs');
const [inputFile, outputFile] = process.argv.slice(2);
const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
async function run() {
  let output;
  if (input.op === 'updateTransport') {
    let call;
    const transport = require('../../src/server/update.cjs').transportFor(input.home, {
      platform: input.platform,
      execute: async (exe, args) => {
        call = { exe, args };
        throw Object.assign(Error('Command failed PRIVATE-PATH'), {
          code: input.code,
          stderr: Buffer.from(input.stderr, 'base64'),
        });
      },
    });
    try {
      if (input.quick) await transport.readJson('https://github.com/fixture/package.zip');
      else await transport.download('https://github.com/fixture/package.zip', 'fixture-output.zip');
    } catch (error) {
      output = { ...call, message: error.message, curl: error.curl };
    }
  } else if (input.op === 'stopProcess') {
    try {
      await require('../../src/platform/process-stop.cjs').stopProcesses([input.pid]);
      output = { failed: false };
    } catch (error) {
      output = {
        failed: true,
        permissionDenied: error.code === 'EPERM' || error.code === 'EACCES',
      };
    }
  } else if (input.op === 'clientSnapshot')
    output = require('../../src/clients/client-status.cjs').snapshot(input.home, input.bridge, {
      inventory: input.inventory,
    });
  else if (input.op === 'serviceTier')
    output =
      (await require('../../src/diagnostics/thread-routing.cjs').savedServiceTier(input.file)) ??
      null;
  else if (input.op === 'otherInstallAction')
    output = require('../../src/platform/app-lifecycle.cjs').otherInstallAction(
      input.old,
      input.current,
    );
  else if (input.op === 'windowsProxyEnv')
    output = require('../../src/platform/platform.cjs').windowsProxyEnv(input.value);
  else if (input.op === 'subscription') {
    output = await require('../../src/accounts/quota-reader.cjs').readSubscription(
      input.authFile,
      input.options,
    );
  } else if (input.op === 'proxySource') {
    const platform = require('../../src/platform/platform.cjs');
    const env = platform.codexEnv(input.home);
    output = {
      source: platform.proxySource(input.home),
      env: Object.fromEntries(
        Object.entries(env).filter(([k]) =>
          [
            'HTTPS_PROXY',
            'https_proxy',
            'HTTP_PROXY',
            'http_proxy',
            'ALL_PROXY',
            'all_proxy',
            'CODEX_HOME',
          ].includes(k),
        ),
      ),
    };
  } else if (input.op === 'accountStore') {
    try {
      const accounts = require('../../src/accounts/accounts.cjs').createAccounts({
        codexHome: input.home,
        bridgeHome: input.bridge,
      });
      accounts.captureCurrent();
      if (input.method === 'prepare') {
        try {
          output = { id: (await accounts.prepare(input.id)).id };
        } catch (error) {
          output = { error: error.message, kind: error.kind };
        }
      } else
        output = {
          changed:
            input.method === 'merge'
              ? accounts.mergeAuth(input.auth)
              : accounts.syncLocalAuth(input.auth),
        };
    } catch (error) {
      output = { error: error.message };
    }
  } else if (input.op === 'discoverProviders') {
    const core = require('../../src/config/core.cjs');
    const providers = core.discoverProviders(input.home);
    output = { providers, public: core.publicProviders(providers) };
  } else if (input.op === 'tomlPreserve') {
    try {
      const core = require('../../src/config/core.cjs');
      if (input.method === 'cleanup') {
        const path = require('node:path'),
          os = require('node:os');
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-cleanup-vector-'));
        try {
          const file = path.join(home, 'config.toml');
          fs.writeFileSync(file, input.text);
          const result = core.cleanupBridge(home, input.catalog);
          output = { ...result, text: fs.readFileSync(file, 'utf8') };
        } finally {
          fs.rmSync(home, { recursive: true, force: true });
        }
      } else {
        const result =
          input.method === 'official'
            ? core.prepareOfficialConfig(input.text, input.model, input.catalog, input.credentials)
            : core.prepareConfig(input.text, input.provider, input.model, input.catalog);
        output = { text: result };
      }
    } catch (error) {
      output = { error: error.message };
    }
  } else if (input.op === 'redact') output = redact(input.value);
  else if (input.op === 'log') {
    log(input.bridge, input.event, input.fields);
    output = readRecent(input.bridge, 2000);
  } else throw Error('Unknown fixture operation');
  fs.writeFileSync(outputFile, JSON.stringify(output));
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
