'use strict';

const path = require('node:path');

// 所有应用资源和默认数据目录都以项目根目录定位，避免迁移源码时改变用户数据位置。
const PROJECT_ROOT = path.resolve(__dirname, '..');

module.exports = { PROJECT_ROOT };
