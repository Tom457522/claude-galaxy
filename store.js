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
  budgetDailyUsd: 0, budgetJobUsd: 0, budgetSessionWarnUsd: 0, // 0 は「上限なし」
  budgetIncludeCloud: true, // クラウドセッションの使用額も 1 日の上限に数える
  // プランの利用率がこの % に達したらジョブを待たせる(0 は 100% = 実際の上限)。planPaceGuard は週のペースより先行したら待たせる
  planLimitSessionPct: 0, planLimitWeeklyPct: 0, planPaceGuard: false, planPaceMargin: 10,
  planMonthlyUsd: 0, // 月額の上書き(0 はプランから自動)
  notifyDesktop: true, // 承認待ち・ジョブの完了・予算をデスクトップに通知する(画面側で使う)
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

// ---- バックアップと復元 ----
// 設定・一覧などの小さいファイルだけを 1 つの JSON にまとめる(画面出力のログと監査ログは含めない)
const BACKUP_FILES = ['settings.json', 'apps.json', 'sessions.json', 'jobs.json', 'automations.json', 'bus.json', 'mcp-servers.json', 'spend.json'];
const PENDING_DIR = path.join(DATA_DIR, 'restore-pending');

function exportBackup({ secrets = false } = {}) {
  const files = {};
  for (const name of BACKUP_FILES) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); } catch (_) { continue; }
    // MCP サーバーの環境変数・ヘッダー(秘密が入りうる)は、指定がなければ伏せる
    if (name === 'mcp-servers.json' && !secrets && Array.isArray(data.servers)) {
      data.servers = data.servers.map((s) => ({
        ...s,
        env: Object.fromEntries(Object.keys(s.env || {}).map((k) => [k, ''])),
        headers: Object.fromEntries(Object.keys(s.headers || {}).map((k) => [k, ''])),
      }));
    }
    files[name] = data;
  }
  return { app: 'claude-galaxy', version: 1, createdAt: new Date().toISOString(), secrets, files };
}

// 復元は、動いているサーバーの保存で上書きされないよう、次の起動時に反映する
function stageRestore(bundle) {
  if (!bundle || bundle.app !== 'claude-galaxy' || typeof bundle.files !== 'object') throw new Error('Claude Galaxy のバックアップではありません');
  const names = Object.keys(bundle.files).filter((n) => BACKUP_FILES.includes(n));
  if (!names.length) throw new Error('復元できるファイルが入っていません');
  fs.rmSync(PENDING_DIR, { recursive: true, force: true });
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(PENDING_DIR, n), JSON.stringify(bundle.files[n], null, 2), { mode: 0o600 });
  return names;
}

// 起動時(各データを読み込む前)に呼ぶ。元のファイルは .bak として残す
function applyPendingRestore() {
  let names = [];
  try { names = fs.readdirSync(PENDING_DIR).filter((n) => BACKUP_FILES.includes(n)); } catch (_) { return []; }
  for (const n of names) {
    const dest = path.join(DATA_DIR, n);
    try { if (fs.existsSync(dest)) fs.copyFileSync(dest, `${dest}.bak`); } catch (_) { /* ignore */ }
    fs.copyFileSync(path.join(PENDING_DIR, n), dest);
  }
  fs.rmSync(PENDING_DIR, { recursive: true, force: true });
  return names;
}

const pendingRestore = () => { try { return fs.readdirSync(PENDING_DIR); } catch (_) { return []; } };

module.exports = {
  load, save, appendLog, closeLog, readLogTail, removeLog, closeAll, loadSettings, saveSettings, DATA_DIR,
  exportBackup, stageRestore, applyPendingRestore, pendingRestore,
};
