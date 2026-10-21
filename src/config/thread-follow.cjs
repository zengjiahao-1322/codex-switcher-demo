'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { readJson } = require('../accounts/accounts.cjs');
const MODES = ['ask', 'off', 'matching', 'all'];
function mode(bridgeHome, override) {
  const value =
    override ?? readJson(path.join(bridgeHome, 'settings.json'), {}).threadFollow ?? 'ask';
  if (!MODES.includes(value)) throw Error('旧对话跟随模式无效。');
  return value;
}
function selectedMode(bridgeHome, override) {
  const value = mode(bridgeHome, override);
  if (value === 'ask')
    throw Object.assign(Error('请先选择本次是否让旧对话跟随新来源。'), {
      code: 'thread_follow_required',
      status: 409,
    });
  return value;
}
function provider(codexHome) {
  try {
    const config = require('smol-toml').parse(
      fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'),
    );
    return config.model_provider || 'openai';
  } catch (error) {
    if (error.code === 'ENOENT') return 'openai';
    throw error;
  }
}
module.exports = { MODES, mode, selectedMode, provider };
