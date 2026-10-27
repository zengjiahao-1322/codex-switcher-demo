'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '..');
const isRust = process.env.SWITCHER_BACKEND === 'rust';
const rustBinary = () =>
  process.env.SWITCHER_RUST_EXE ||
  path.join(
    root,
    'rust',
    'target',
    'release',
    'switcher-prototype' + (process.platform === 'win32' ? '.exe' : ''),
  );

// Only the transport/lifetime changes. JS callbacks, mocks and actions are never
// forwarded to Node when Rust is selected; unsupported Rust behavior must fail.
function createServer(options, fixture = {}) {
  if (!isRust) return require('../src/server/server.cjs').createServer(options);
  const server = new EventEmitter();
  let child, address, startupError;
  let temporaryRoot;
  const home =
    fixture.codexHome ||
    (() => {
      temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-rust-http-'));
      const dir = path.join(temporaryRoot, 'codex');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'config.toml'), 'model="fixture"\n');
      return dir;
    })();
  const bridge = fixture.bridgeHome || path.join(temporaryRoot || home, 'bridge');
  fs.mkdirSync(bridge, { recursive: true });
  server.listening = false;
  server.listen = (port, host, callback) => {
    if (host !== '127.0.0.1') throw Error('Test backend must bind loopback');
    let settled = false;
    const ready = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      startupError = error;
      if (value) {
        address = { address: host, family: 'IPv4', port: value.port };
        server.url = value.url;
        server.listening = true;
      }
      callback?.(error);
    };
    let stdout = '',
      stderr = '';
    const deadline = setTimeout(() => {
      child.kill();
      ready(Error('Rust backend startup timed out: ' + stderr));
    }, 10000);
    child = spawn(rustBinary(), [], {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...fixture.env,
        CODEX_HOME: home,
        BRIDGE_CODEX_HOME: home,
        BRIDGE_HOME: bridge,
        BRIDGE_PORT: String(port),
        SWITCHER_WEB_ROOT: path.join(root, 'web'),
        SWITCHER_TEST_TOKEN: options.token || 'fixture-token',
      },
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.stdout.on('data', (data) => {
      stdout += data;
      const line = stdout.split(/\r?\n/).find((line) => line.startsWith('{'));
      if (line && stdout.includes('\n')) {
        try {
          ready(null, JSON.parse(line));
        } catch (error) {
          ready(error);
        }
      }
    });
    child.once('error', (error) => ready(error));
    child.once('exit', (code) => {
      server.listening = false;
      ready(Error('Rust backend exited ' + code + ': ' + stderr));
    });
    return server;
  };
  server.address = () => {
    if (startupError) throw startupError;
    return address;
  };
  server.close = (callback) => {
    server.listening = false;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      callback?.();
      return server;
    }
    child.once('exit', () => {
      server.emit('close');
      callback?.();
    });
    child.kill();
    return server;
  };
  server.closeAllConnections = () => child?.kill();
  return server;
}

module.exports = { createServer, isRust, rustBinary };
