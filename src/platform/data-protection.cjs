'use strict';
const fs = require('node:fs');
const { privateAcl } = require('../config/core.cjs');

// 启动时先保护目录，之后创建的账号、连接与临时文件继承该权限。
function protectDataDirs(paths) {
  const errors = [];
  for (const dir of new Set(paths)) {
    fs.mkdirSync(dir, { recursive: true });
    try {
      privateAcl(dir);
      // 已有 Windows 文件可能禁用了继承；重新启用继承并移除显式授权。
      if (process.platform === 'win32' && fs.readdirSync(dir).length) {
        require('node:child_process').execFileSync(
          'icacls.exe',
          [require('node:path').join(dir, '*'), '/reset', '/T', '/Q'],
          {
            windowsHide: true,
            stdio: 'pipe',
            timeout: 15000,
          },
        );
      }
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
