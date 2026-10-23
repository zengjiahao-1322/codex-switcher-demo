'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const MODES = ['off', 'matching', 'all'];
function selectedMode(_bridgeHome, override) {
  const value = override ?? 'all';
  if (!MODES.includes(value)) throw Error('旧对话跟随模式无效。');
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
module.exports = { MODES, selectedMode, provider };
