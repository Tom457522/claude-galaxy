'use strict';
// 画面なしで本体を起動する(Windows のログオン時に background.vbs から呼ばれる)。
//   - すでに同じポートで動いていれば何もしない(二重起動すると、動いている方の一時ファイルを消してしまうため)
//   - 出力は ~/.claude-galaxy/server.log に追記する(5MB を超えたら server.log.1 に回す)
//   - 本体の終了コードで終わるので、タスク スケジューラの「失敗時に再起動」が効く

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { DATA_DIR } = require('./store');

const PORT = Number(process.env.PORT) || 3456;
const LOG = path.join(DATA_DIR, 'server.log');
const MAX_LOG = 5 * 1024 * 1024;

function inUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(2000, () => { s.destroy(); resolve(false); });
  });
}

(async () => {
  if (await inUse(PORT)) {
    console.log(`ポート ${PORT} で動いているので起動しません`);
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { if (fs.statSync(LOG).size > MAX_LOG) fs.renameSync(LOG, `${LOG}.1`); } catch (_) { /* まだない */ }
  const out = fs.openSync(LOG, 'a');
  fs.writeSync(out, `\n--- ${new Date().toLocaleString()} 画面なしで起動 ---\n`);
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname, stdio: ['ignore', out, out], windowsHide: true,
  });
  child.on('exit', (code) => process.exit(code ?? 1));
})();
