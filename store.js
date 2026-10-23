'use strict';
// セッション定義と出力ログの保存。保存先: ~/.claude-galaxy/
//   sessions.json : セッションの設定(名前・cwd・コマンド・Claude のセッション ID・使用量など)
//   logs/<id>.log : PTY の出力(再起動後に直近分を再表示する)

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.claude-galaxy');
const FILE = path.join(DATA_DIR, 'sessions.json');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_MAX = 4 * 1024 * 1024; // これを超えたら直近分だけ残して詰める

const logPath = (id) => path.join(LOG_DIR, `${id}.log`);

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(data.sessions) ? data.sessions.filter((s) => s && /^s\d+$/.test(s.id)) : [];
  } catch (_) {
    return [];
  }
}

function saveNow(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ sessions: list }, null, 2));
  fs.renameSync(tmp, FILE);
}

// 頻繁に呼ばれても書き込みは 500ms に 1 回にまとめる
let timer = null;
let pending = null;
function save(getList, { now = false } = {}) {
  pending = getList;
  if (now) {
    clearTimeout(timer);
    timer = null;
    try { saveNow(pending()); } catch (e) { console.error('sessions.json を保存できません:', e.message); }
    return;
  }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try { saveNow(pending()); } catch (e) { console.error('sessions.json を保存できません:', e.message); }
  }, 500);
  timer.unref();
}

// ---- 出力ログ ----
const streams = new Map();

function openLog(id) {
  if (streams.has(id)) return streams.get(id);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const ws = fs.createWriteStream(logPath(id), { flags: 'a' });
  ws.on('error', () => { /* ログが書けなくても本体は止めない */ });
  streams.set(id, ws);
  return ws;
}

function appendLog(id, data) { openLog(id).write(data); }

function closeLog(id) {
  const ws = streams.get(id);
  if (ws) { ws.end(); streams.delete(id); }
}

// 直近 maxChars 文字ぶんを読み出す(大きすぎるログはここで詰める)
function readLogTail(id, maxChars) {
  const file = logPath(id);
  let st;
  try { st = fs.statSync(file); } catch (_) { return ''; }
  const bytes = Math.min(st.size, maxChars * 3);
  const buf = Buffer.alloc(bytes);
  try {
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, bytes, st.size - bytes); } finally { fs.closeSync(fd); }
  } catch (_) { return ''; }
  let text = buf.toString('utf8');
  if (bytes < st.size) text = text.replace(/^[^\n]*\n?/, ''); // 途中から読んだ最初の行は捨てる
  text = text.slice(-maxChars);
  if (st.size > LOG_MAX) {
    try { fs.writeFileSync(file, text); } catch (_) { /* ignore */ }
  }
  return text;
}

function removeLog(id) {
  closeLog(id);
  try { fs.unlinkSync(logPath(id)); } catch (_) { /* ignore */ }
}

function closeAll() { for (const id of [...streams.keys()]) closeLog(id); }

// ---- アプリ全体の設定(~/.claude-galaxy/settings.json) ----
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SETTINGS_DEFAULTS = {
  permissionInbox: true, busEnabled: true, maxConcurrentJobs: 2, auditEnabled: true, auditDays: 30, worktreeDir: '', dispatchModel: 'haiku',
};

function loadSettings() {
  try {
    return { ...SETTINGS_DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch (_) {
    return { ...SETTINGS_DEFAULTS };
  }
}

function saveSettings(settings) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

module.exports = {
  load, save, appendLog, closeLog, readLogTail, removeLog, closeAll, loadSettings, saveSettings, DATA_DIR,
};
