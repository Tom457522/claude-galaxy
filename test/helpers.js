'use strict';
// テスト共通: HOME を一時フォルダにしてから require する(保存先 ~/.claude-galaxy を汚さないため)
const fs = require('fs');
const os = require('os');
const path = require('path');

function tempHome(prefix = 'galaxy-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return dir;
}

module.exports = { tempHome };
