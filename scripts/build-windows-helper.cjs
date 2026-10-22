'use strict';

const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process');

if (process.platform !== 'win32') {
  console.log('Windows process helper is only built on Windows.');
  process.exit(0);
}

const project = path.resolve(__dirname, '..'),
  source = path.join(project, 'platform', 'windows', 'process-context.cs'),
  outputDir = path.join(project, 'bin'),
  output = path.join(outputDir, 'process-context.exe'),
  compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

if (!fs.existsSync(compiler)) throw Error('未找到 Windows C# 编译器：' + compiler);
fs.mkdirSync(outputDir, { recursive: true });
cp.execFileSync(
  compiler,
  [
    '/nologo',
    '/optimize+',
    '/target:exe',
    '/platform:x64',
    '/r:System.Web.Extensions.dll',
    '/out:' + output,
    source,
  ],
  { windowsHide: true, stdio: 'inherit' },
);
console.log('Windows process helper built: ' + output);
