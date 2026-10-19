'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process');
const pkg = process.env.CODEX_NPM_ROOT;
if (!pkg) throw Error('CODEX_NPM_ROOT required');
const platform = process.platform === 'darwin' ? 'apple-darwin' : 'pc-windows-msvc',
  arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64',
  name = process.platform === 'win32' ? 'codex.exe' : 'codex';
function find(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = find(p);
      if (r) return r;
    } else if (e.name === name && p.includes(arch + '-' + platform)) return p;
  }
  return null;
}
const exe = find(path.join(pkg, '@openai'));
if (!exe) throw Error('Native Codex executable missing under ' + pkg);
fs.appendFileSync(process.env.GITHUB_ENV, 'CODEX_EXE=' + exe + '\n');
if (process.platform === 'darwin') {
  fs.mkdirSync('bin', { recursive: true });
  cp.execFileSync('clang', [
    '-O2',
    '-Wall',
    '-Wextra',
    '-mmacosx-version-min=12.0',
    'mac-process-context.c',
    '-o',
    'bin/mac-process-context',
  ]);
}
console.log('Native Codex located; platform helper ready.');
