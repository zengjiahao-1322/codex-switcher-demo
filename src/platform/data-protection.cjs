'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { privateAcl } = require('../config/core.cjs');

// 启动时先保护目录，之后创建的账号、连接与临时文件继承该权限。
function protectDataDirs(paths) {
  const errors = [];
  for (const dir of new Set(paths)) {
    fs.mkdirSync(dir, { recursive: true });
    try {
      const marker = path.join(dir, 'acl-protected.json'),
        protectedPath = path.resolve(dir);
      if (
        fs.existsSync(marker) &&
        JSON.parse(fs.readFileSync(marker, 'utf8')).path === protectedPath
      )
        continue;
      privateAcl(dir);
      // 已有 Windows 文件可能禁用了继承；重新启用继承并移除显式授权。
      if (process.platform === 'win32' && fs.readdirSync(dir).length) {
        require('node:child_process').execFileSync(
          'icacls.exe',
          [path.join(dir, '*'), '/reset', '/T', '/Q'],
          {
            windowsHide: true,
            stdio: 'pipe',
            timeout: 15000,
          },
        );
      }
      // 完整收紧成功后才记下目录；搬到新位置时重新收紧。
      fs.writeFileSync(marker, JSON.stringify({ path: protectedPath }), { mode: 0o600 });
    } catch (error) {
      errors.push(dir + '：' + error.message);
    }
  }
  return {
    ok: errors.length === 0,
    path: paths[0],
    ...(errors.length ? { error: errors.join('\n') } : {}),
  };
}
module.exports = { protectDataDirs };
