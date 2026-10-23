'use strict';

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { buildGraph } = require('./graph');
const appsStore = require('./apps');
const store = require('./store');
const { UsageTracker } = require('./usage');
const { createJobManager } = require('./jobs');
const { createAutomations } = require('./automations');
const { createBus } = require('./bus');

const IS_WIN = process.platform === 'win32';
const HOST = '127.0.0.1'; // ローカルホスト限定(外部公開しない)
const PORT = Number(process.env.PORT) || 3456;
// ローカル Web アプリ専用のポート(本体と別オリジンにして、/api や /ws を触れないようにする)
const APPS_PORT = Number(process.env.APPS_PORT) || PORT + 1;
const DEFAULT_COMMAND = process.env.CLAUDE_CMD || 'claude';

// Claude Code の標準インストール先が PATH に無い環境向けに、存在するものを PATH 末尾へ補う
// (ネイティブインストーラは ~/.local/bin に入れるが PATH 登録されていないことがある)
function augmentPath() {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const sep = path.delimiter;
  const cur = (process.env[key] || '').split(sep).filter(Boolean);
  const norm = (p) => path.resolve(p).toLowerCase();
  const have = new Set(cur.map(norm));
  const home = os.homedir();
  const candidates = [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local')];
  if (IS_WIN && process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm'));
  const add = candidates.filter((d) => fs.existsSync(d) && !have.has(norm(d)));
  if (add.length) process.env[key] = [...cur, ...add].join(sep);
}
augmentPath();
const SCROLLBACK_LIMIT = 200 * 1024; // 再接続時に再生するバッファ上限(文字数)

// ---- Claude Code hooks 連携 ----
const HOOK_TOKEN = crypto.randomBytes(16).toString('hex');
const HOOK_JS = path.join(__dirname, 'hook.js');
const HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification',
  'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'SessionEnd',
];
// 権限確認を受信箱で待つ上限(秒)。過ぎたら通常の確認ダイアログに戻す
const PERMISSION_WAIT = Math.max(10, Number(process.env.GALAXY_PERMISSION_WAIT) || 300);
const TMP_DIR = path.join(os.tmpdir(), 'claude-galaxy');
const SETTINGS_FILE = path.join(TMP_DIR, `hooks-${PORT}.json`);
const MCP_JS = path.join(__dirname, 'mcp-bus.js');
// 共有バスのツールのうち、読むだけのもの・自分の記録を書くだけのものは確認なしで使えるようにする
// (ジョブの登録・中止、ほかのセッションへの入力、メモリの削除は確認が要る)
const BUS_AUTO_ALLOW = [
  'list_agents', 'read_messages', 'send_message', 'get_job', 'list_jobs', 'memory_read', 'memory_search', 'memory_write',
].map((t) => `mcp__galaxy__${t}`);
const fwd = (p) => p.replace(/\\/g, '/'); // bash / PowerShell / cmd のどれでも通るよう / 区切りにする

// このアプリで起動した claude にだけ渡す(--settings)。ユーザーの settings.json は書き換えない。
function writeHookSettings() {
  const hooks = {};
  for (const ev of HOOK_EVENTS) {
    hooks[ev] = [{
      hooks: [{ type: 'command', command: `node "${fwd(HOOK_JS)}" ${ev}`, async: true, timeout: 5 }],
    }];
  }
  // 権限確認だけは同期 hook(決定を返すため)。受信箱で決まるまで Claude 側は待つ
  hooks.PermissionRequest = [{
    hooks: [{ type: 'command', command: `node "${fwd(HOOK_JS)}" PermissionRequest`, timeout: PERMISSION_WAIT + 30 }],
  }];
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ hooks, permissions: { allow: BUS_AUTO_ALLOW } }, null, 2));
}

// エージェントごとの MCP 設定(共有バス)。トークンを含むので本人だけが読めるようにする
const mcpFile = (id) => path.join(TMP_DIR, `mcp-${PORT}-${id}.json`);
function writeMcpConfig(id) {
  if (!settings.busEnabled) return null;
  const file = mcpFile(id);
  const conf = {
    mcpServers: {
      galaxy: {
        type: 'stdio',
        command: 'node',
        args: [fwd(MCP_JS)],
        env: { GALAXY_PORT: String(PORT), GALAXY_TOKEN: HOOK_TOKEN, GALAXY_SESSION: id },
      },
    },
  };
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(conf, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows */ }
  return file;
}
function removeMcpConfig(id) {
  try { fs.unlinkSync(mcpFile(id)); } catch (_) { /* ignore */ }
}

const CLAUDE_SUBCOMMANDS = new Set([
  'update', 'install', 'doctor', 'mcp', 'plugin', 'plugins', 'auth', 'agents', 'attach', 'logs',
  'rm', 'stop', 'kill', 'respawn', 'daemon', 'remote-control', 'setup-token', 'purge', 'import',
  'gateway', 'ultrareview', 'auto-mode', 'self-hosted-runner',
]);

// 利用者が書いた --resume / --continue を外す(再開時はこちらで ID を指定するため)
function stripResumeFlags(rest) {
  return rest
    .replace(/(^|\s)(--continue|-c)(?=\s|$)/g, '$1')
    .replace(/(^|\s)(--resume|-r)(=|\s+)(?!-)("[^"]*"|\S+)/g, '$1')
    .replace(/(^|\s)(--resume|-r)(?=\s|$)/g, '$1');
}

const SAFE_ID = /^[A-Za-z0-9_-]{8,100}$/;

// 起動コマンドが claude の対話起動なら、先頭語の直後に --settings を差し込む
//   resumeId を渡すと、--resume <id> も付ける(会話の再開)。mcp を渡すと --mcp-config も付ける
function injectSettings(cmdline, resumeId, mcp) {
  const m = /^("[^"]+"|\S+)([\s\S]*)$/.exec(cmdline.trim());
  if (!m) return { cmd: cmdline, injected: false };
  const first = m[1].replace(/^"|"$/g, '');
  const base = path.basename(first.replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  if (base !== 'claude') return { cmd: cmdline, injected: false };
  let rest = m[2];
  if (/(^|\s)--settings(\s|=)/.test(rest)) return { cmd: cmdline, injected: false }; // 利用者が自分で指定済み
  const next = rest.trim().split(/\s+/)[0];
  if (next && CLAUDE_SUBCOMMANDS.has(next)) return { cmd: cmdline, injected: false };
  let resume = '';
  if (resumeId && SAFE_ID.test(resumeId)) {
    rest = stripResumeFlags(rest);
    resume = ` --resume ${resumeId}`;
  }
  // --mcp-config は複数の値を取るので、直後に --settings を置いて区切る
  const mcpArg = mcp ? ` --mcp-config "${fwd(mcp)}"` : '';
  return { cmd: `${m[1]}${mcpArg} --settings "${fwd(SETTINGS_FILE)}"${resume}${rest}`, injected: true, resumed: !!resume };
}

const app = express();

// DNS rebinding / CSRF 対策: Host は localhost / 127.0.0.1 のみ、Origin があるなら自分自身のみ許可
const OK_ORIGINS = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
app.use((req, res, next) => {
  const host = (req.headers.host || '').split(':')[0];
  if (host !== 'localhost' && host !== '127.0.0.1') return res.status(403).end('forbidden');
  const origin = req.headers.origin;
  if (origin && !OK_ORIGINS.includes(origin)) return res.status(403).end('forbidden');
  next();
});
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use('/vendor/addon-web-links', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links')));

/** @type {Map<string, any>} */
const sessions = new Map();
let seq = 0;
let settings = store.loadSettings();
let shuttingDown = false;

// ---- 永続化 ----
const persistInfo = (s) => ({
  id: s.id,
  name: s.name,
  cwd: s.cwd,
  command: s.command,
  appId: s.appId,
  createdAt: s.createdAt,
  claudeSessionId: s.claudeSessionId,
  transcripts: s.usage.files(),
  usage: s.usage.totals,
});
const persist = (opts) => store.save(() => [...sessions.values()].map(persistInfo), opts);

// ---- SSE(状態変化をブラウザへ配信) ----
const sseClients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const r of sseClients) r.write(msg);
}
setInterval(() => { for (const r of sseClients) r.write(': ping\n\n'); }, 25000).unref();

function resolveCwd(input) {
  // エクスプローラーの「パスのコピー」は "C:\..." のように引用符付きになることがあるので外す
  input = (input || '').trim().replace(/^"(.*)"$/, '$1');
  if (!input) return os.homedir();
  const isHome = input === '~' || input.startsWith('~/') || input.startsWith('~\\');
  const expanded = isHome ? path.join(os.homedir(), input.slice(1)) : input;
  const abs = path.resolve(expanded);
  try {
    if (fs.statSync(abs).isDirectory()) return abs;
  } catch (_) { /* fallthrough */ }
  throw new Error(`ディレクトリが見つかりません: ${abs}`);
}

// 起動コマンドの先頭語(引用符付きパスにも対応)
function firstToken(cmdline) {
  const m = /^"([^"]+)"|^(\S+)/.exec(cmdline.trim());
  return m ? (m[1] || m[2]) : '';
}

const WIN_EXTS = ['', '.exe', '.cmd', '.bat', '.com'];

// 起動コマンドが PATH 上(またはフルパス)に存在するか確認する
function assertCommandExists(cmdline, shell, cwd) {
  const first = firstToken(cmdline);
  if (!first) throw new Error('起動コマンドが空です');
  const pathLike = /[\\/]/.test(first);
  let found = false;
  try {
    if (IS_WIN) {
      if (pathLike) {
        found = WIN_EXTS.some((e) => fs.existsSync(path.resolve(cwd, first + e)));
      } else {
        execFileSync('where.exe', [first], { cwd, stdio: 'ignore' });
        found = true;
      }
    } else {
      execFileSync(shell, ['-l', '-c', 'command -v -- "$1" >/dev/null 2>&1', 'sh', first], { cwd, stdio: 'ignore' });
      found = true;
    }
  } catch (_) { found = false; }
  if (found) return;
  const hint = IS_WIN
    ? `PowerShell で「Get-Command ${first}」を実行して場所を確認し、フルパス(例: "C:\\Users\\you\\.local\\bin\\claude.exe")で指定してください。` +
      'WSL 内の Claude Code を使う場合は「wsl claude」と指定します。'
    : `ターミナルで「which ${first}」を確認するか、フルパスで指定してください。`;
  throw new Error(`コマンドが見つかりません: ${first}\nPATH にありません。${hint}`);
}

// ---- セッション状態 ----
function setStatus(s, status, detail = '') {
  if (s.status === status && s.statusDetail === detail) return false;
  if (s.status !== status) s.statusSince = Date.now();
  s.status = status;
  s.statusDetail = detail;
  return true;
}

const publicInfo = (s) => ({
  id: s.id,
  name: s.name,
  cwd: s.cwd,
  command: s.command,
  alive: s.alive,
  exitCode: s.exitCode,
  createdAt: s.createdAt,
  status: s.status,
  statusDetail: s.statusDetail,
  statusSince: s.statusSince,
  injected: s.injected,
  agents: s.agents,
  appId: s.appId,
  claudeSessionId: s.claudeSessionId,
  resumable: !!s.claudeSessionId && isClaudeCommand(s.command),
  restored: s.restored,
  usage: s.usage.totals,
  permissions: [...permissions.values()].filter((x) => x.sessionId === s.id).length,
  unread: bus.unreadCount(s.id),
});
const emit = (s) => broadcast('session', publicInfo(s));

const WAIT_TYPES = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
const TASK_TOOLS = new Set(['Task', 'Agent']);
const MAX_AGENTS = 30;

function findAgent(s, id) { return s.agents.find((a) => a.id === id); }

function ensureAgent(s, id, type) {
  let a = findAgent(s, id);
  if (!a) {
    a = { id, type: type || 'agent', description: '', status: 'running', startedAt: Date.now(), endedAt: null, lastTool: '', summary: '' };
    s.agents.push(a);
    if (s.agents.length > MAX_AGENTS) s.agents.splice(0, s.agents.length - MAX_AGENTS);
  }
  return a;
}

// hook イベントをセッション状態に反映する
function applyHook(s, p) {
  const ev = p.hook_event_name;
  if (!ev) return;
  s.hooked = true;
  const inSub = !!p.agent_id;
  const now = Date.now();
  trackTranscript(s, p);
  clearStalePermissions(s, p);
  s.pendingAgents = s.pendingAgents.filter((x) => now - x.at < 60000);

  switch (ev) {
    case 'SessionStart':
      setStatus(s, 'idle');
      break;

    case 'UserPromptSubmit':
      clearTimeout(s.doneTimer);
      s.agents = s.agents.filter((a) => a.status === 'running'); // 前ターンの完了分は片付ける
      setStatus(s, 'working', '');
      break;

    case 'PreToolUse':
    case 'PostToolUse':
      clearTimeout(s.doneTimer);
      if (ev === 'PreToolUse' && TASK_TOOLS.has(p.tool_name) && p.task) {
        s.pendingAgents.push({ type: p.task.subagent_type, description: p.task.description, at: now });
      }
      if (inSub) {
        const a = ensureAgent(s, p.agent_id, p.agent_type);
        if (a.status === 'running' && p.tool_name) a.lastTool = p.tool_name;
      }
      setStatus(s, 'working', inSub ? s.statusDetail : (ev === 'PreToolUse' ? (p.tool_name || '') : s.statusDetail));
      break;

    case 'Notification': {
      const t = p.notification_type || '';
      const msg = p.message || '';
      if (t === 'idle_prompt') setStatus(s, 'idle');
      else if (WAIT_TYPES.has(t) || (!t && /permission|needs your|waiting for|approve/i.test(msg))) {
        setStatus(s, 'waiting', msg.slice(0, 100));
      } else return; // それ以外の通知は状態を変えない
      break;
    }

    case 'Stop':
      scheduleUsage(s, 300);
      if (inSub) return;
      setStatus(s, 'done');
      clearTimeout(s.doneTimer);
      s.doneTimer = setTimeout(() => { if (s.status === 'done' && setStatus(s, 'idle')) emit(s); }, 5000);
      break;

    case 'StopFailure':
      setStatus(s, 'error', p.error || 'API エラー');
      break;

    case 'SubagentStart': {
      const id = p.agent_id || `sub-${now}`;
      const a = ensureAgent(s, id, p.agent_type);
      if (p.agent_type) a.type = p.agent_type;
      let idx = s.pendingAgents.findIndex((x) => x.type && x.type === a.type);
      if (idx < 0) idx = s.pendingAgents.length ? 0 : -1;
      if (idx >= 0) a.description = s.pendingAgents.splice(idx, 1)[0].description || '';
      a.status = 'running';
      a.startedAt = now;
      setStatus(s, 'working', s.statusDetail);
      break;
    }

    case 'SubagentStop': {
      scheduleUsage(s, 300);
      const a = ensureAgent(s, p.agent_id || `sub-${now}`, p.agent_type);
      a.status = 'done';
      a.endedAt = now;
      if (p.last_assistant_message) a.summary = p.last_assistant_message.slice(0, 160);
      break;
    }

    case 'SessionEnd':
      scheduleUsage(s, 300);
      for (const a of s.agents) if (a.status === 'running') { a.status = 'stopped'; a.endedAt = now; }
      setStatus(s, 'idle');
      break;

    default:
      return;
  }
  emit(s);
}

// Claude Code の対話起動か(hooks を差し込めるか)
function isClaudeCommand(cmdline) {
  return injectSettings(cmdline || '').injected;
}

// Claude のセッション ID とトランスクリプトの場所を覚える(再開とコスト集計に使う)
function trackTranscript(s, p) {
  let dirty = false;
  if (p.session_id && SAFE_ID.test(p.session_id) && p.session_id !== s.claudeSessionId) {
    s.claudeSessionId = p.session_id;
    dirty = true;
  }
  for (const f of [p.transcript_path, p.agent_transcript_path]) {
    if (typeof f === 'string' && f && !s.usage.readers.has(f)) { s.usage.addFile(f); dirty = true; }
  }
  if (dirty) persist();
  if (p.hook_event_name === 'PostToolUse' || p.hook_event_name === 'UserPromptSubmit') scheduleUsage(s, 3000);
}

// トランスクリプトを読み直して使用量を更新する(連続したイベントはまとめる)
function scheduleUsage(s, delay) {
  if (s.usageTimer) return;
  s.usageTimer = setTimeout(() => {
    s.usageTimer = null;
    if (!sessions.has(s.id)) return;
    try {
      if (s.usage.refresh()) { emit(s); persist(); }
    } catch (e) { console.error('使用量の集計に失敗:', e.message); }
  }, delay);
  s.usageTimer.unref();
}

function newSessionObject({ id, name, cwd, command, appId, createdAt }) {
  return {
    id,
    name,
    cwd,
    command,
    appId: typeof appId === 'string' && appsStore.get(appId) ? appId : null,
    createdAt: createdAt || Date.now(),
    alive: false,
    exitCode: null,
    proc: null,
    buffer: '',
    clients: new Set(),
    // 再開・集計
    claudeSessionId: null,
    usage: new UsageTracker(),
    usageTimer: null,
    restored: false,
    // 状態
    injected: false,
    hooked: false,
    status: 'starting',
    statusDetail: '',
    statusSince: Date.now(),
    agents: [],
    pendingAgents: [],
    doneTimer: null,
    actTimer: null,
  };
}

function writeOut(session, data) {
  session.buffer += data;
  if (session.buffer.length > SCROLLBACK_LIMIT) {
    session.buffer = session.buffer.slice(-SCROLLBACK_LIMIT);
  }
  store.appendLog(session.id, data);
  for (const ws of session.clients) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data }));
  }
}

// セッションにプロセスを起動する(新規 / 再起動 / 会話の再開で共通)
function spawnSession(session, { resume = false } = {}) {
  const shell = IS_WIN ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/bash');
  assertCommandExists(session.command, shell, session.cwd);

  const mcp = isClaudeCommand(session.command) ? writeMcpConfig(session.id) : null;
  const { cmd: finalCmd, injected, resumed } = injectSettings(session.command, resume ? session.claudeSessionId : null, mcp);
  if (resume && !resumed) throw new Error('このセッションは再開できません(Claude のセッション ID が記録されていません)');

  // Windows: cmd.exe /c で実行(claude.cmd / claude.exe を PATHEXT で解決。終了すると PTY も閉じる)。
  //   引数は文字列で渡して node-pty に余計なクォートをさせない。
  // Unix: ログインシェル経由で PATH(nvm等)を引き継ぎ、終了後にシェルが残らないよう exec する
  const spawnArgs = IS_WIN ? `/d /s /c "${finalCmd}"` : ['-l', '-c', `exec ${finalCmd}`];
  const proc = pty.spawn(shell, spawnArgs, {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd: session.cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      GALAXY_SESSION: session.id,
      GALAXY_PORT: String(PORT),
      GALAXY_TOKEN: HOOK_TOKEN,
    },
  });

  Object.assign(session, {
    proc,
    alive: true,
    exitCode: null,
    injected,
    hooked: false,
    restored: false,
    agents: [],
    pendingAgents: [],
  });
  setStatus(session, 'starting');

  proc.onData((data) => {
    if (session.proc !== proc) return;
    writeOut(session, data);
    // hooks が使えないコマンド(bash 等)は、出力があるかどうかで作業中/待機中を推定する
    if (!session.injected && !session.hooked) {
      if (setStatus(session, 'working')) emit(session);
      clearTimeout(session.actTimer);
      session.actTimer = setTimeout(() => {
        if (session.alive && setStatus(session, 'idle')) emit(session);
      }, 1500);
    }
  });

  proc.onExit(({ exitCode }) => {
    if (session.proc !== proc || shuttingDown) return;
    session.alive = false;
    session.exitCode = exitCode;
    clearTimeout(session.doneTimer);
    clearTimeout(session.actTimer);
    cancelPermissions(session.id);
    for (const a of session.agents) if (a.status === 'running') { a.status = 'stopped'; a.endedAt = Date.now(); }
    setStatus(session, 'exited', `code ${exitCode}`);
    for (const ws of session.clients) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', exitCode }));
    }
    scheduleUsage(session, 300);
    emit(session);
    persist();
  });
}

function createSession({ name, cwd, command, appId, resumeId }) {
  const id = `s${++seq}`;
  const session = newSessionObject({
    id,
    name: name || `session-${seq}`,
    cwd: resolveCwd(cwd),
    command: (command || DEFAULT_COMMAND).trim(),
    appId,
  });
  if (resumeId) session.claudeSessionId = resumeId;
  spawnSession(session, { resume: !!resumeId });
  sessions.set(id, session);
  emit(session);
  persist();
  return session;
}

// 終了したセッションを同じ ID のまま起動し直す(resume: 会話を引き継ぐ)
function restartSession(session, { resume }) {
  if (session.alive) throw new Error('セッションは実行中です');
  session.cwd = resolveCwd(session.cwd); // 保存後にフォルダが消えていたらここで知らせる
  const prev = { injected: session.injected, restored: session.restored };
  try {
    spawnSession(session, { resume });
  } catch (e) {
    Object.assign(session, prev);
    throw e;
  }
  writeOut(session, `\r\n\x1b[2m──── ${resume ? '会話を再開' : '再起動'}: ${new Date().toLocaleString()} ────\x1b[0m\r\n`);
  for (const ws of session.clients) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'restarted' }));
  }
  emit(session);
  persist();
}

// 前回サーバーを止めたときのセッションを、終了状態で並べ直す(再開はボタンから)
function restoreSessions() {
  for (const r of store.load()) {
    let cwd;
    try { cwd = resolveCwd(r.cwd); } catch (_) { cwd = r.cwd; }
    const s = newSessionObject({
      id: r.id, name: r.name || r.id, cwd, command: r.command || DEFAULT_COMMAND, appId: r.appId, createdAt: r.createdAt,
    });
    if (typeof r.claudeSessionId === 'string' && SAFE_ID.test(r.claudeSessionId)) s.claudeSessionId = r.claudeSessionId;
    for (const f of Array.isArray(r.transcripts) ? r.transcripts : []) s.usage.addFile(f);
    if (r.usage && typeof r.usage === 'object') s.usage.totals = { ...s.usage.totals, ...r.usage };
    s.restored = true;
    s.injected = isClaudeCommand(s.command);
    s.buffer = store.readLogTail(s.id, SCROLLBACK_LIMIT);
    setStatus(s, 'exited', 'サーバー再起動で停止');
    sessions.set(s.id, s);
    seq = Math.max(seq, Number(s.id.slice(1)) || 0);
    scheduleUsage(s, 1000); // トランスクリプトが残っていれば集計し直す
  }
}

// ---- 権限確認の受信箱 ----
/** @type {Map<string, any>} */
const permissions = new Map();
let permSeq = 0;

const permInfo = (x) => ({
  id: x.id,
  sessionId: x.sessionId,
  agentName: agentName(x.sessionId),
  at: x.at,
  expiresAt: x.expiresAt,
  tool: x.tool,
  mcpServer: x.mcpServer,
  agentType: x.agentType,
  input: x.input,
  // 「今後も許可」できるのは、許可ルールの追加提案があるときだけ
  rules: x.suggestions.flatMap((u) => (u.type === 'addRules' && u.behavior === 'allow' && Array.isArray(u.rules)
    ? u.rules.map((r) => ({ tool: r.toolName, rule: r.ruleContent || '', destination: u.destination }))
    : [])),
});

function resolvePermission(id, decision) {
  const x = permissions.get(id);
  if (!x) return false;
  permissions.delete(id);
  clearTimeout(x.timer);
  if (!x.res.writableEnded) x.res.json(decision);
  broadcast('permission-removed', { id });
  const s = sessions.get(x.sessionId);
  if (s) {
    const left = [...permissions.values()].some((y) => y.sessionId === s.id);
    if (!left && s.alive && s.status === 'waiting') setStatus(s, decision.behavior === 'deny' ? 'idle' : 'working', '');
    emit(s);
  }
  return true;
}

function cancelPermissions(sessionId, pred = () => true) {
  for (const x of [...permissions.values()]) {
    if (x.sessionId === sessionId && pred(x)) resolvePermission(x.id, { behavior: 'ask' });
  }
}

// ターミナル側で答えた・中断したなどで、もう待っていない確認を片付ける
function clearStalePermissions(s, p) {
  const ev = p.hook_event_name;
  const agent = p.agent_id || null;
  if (ev === 'PostToolUse') {
    cancelPermissions(s.id, (x) => x.agentId === agent && x.tool === p.tool_name);
  } else if (ev === 'UserPromptSubmit' || ev === 'SessionEnd' || ev === 'StopFailure' || (ev === 'Stop' && !agent)) {
    cancelPermissions(s.id);
  }
}

// ---- ジョブ(ヘッドレス実行)----
const SHELL = IS_WIN ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/bash');
// ジョブで使う claude コマンド(CLAUDE_JOB_CMD で変更可。既定は CLAUDE_CMD が claude ならそれ)
const JOB_COMMAND = (process.env.CLAUDE_JOB_CMD || (isClaudeCommand(DEFAULT_COMMAND) ? DEFAULT_COMMAND : 'claude')).trim();
const MAX_AGENT_DEPTH = 3; // ジョブがジョブを登録できる深さ
const MAX_AGENT_JOBS = 20; // エージェントが登録した、待ち・実行中のジョブの上限

function buildJobCommand(job) {
  const m = /^("[^"]+"|\S+)([\s\S]*)$/.exec(JOB_COMMAND);
  const args = ['-p', '--output-format stream-json', '--verbose'];
  const mcp = writeMcpConfig(job.id);
  if (mcp) args.push(`--mcp-config "${fwd(mcp)}"`);
  args.push(`--settings "${fwd(SETTINGS_FILE)}"`);
  if (job.model) args.push(`--model ${job.model}`);
  if (job.permissionMode) args.push(`--permission-mode ${job.permissionMode}`);
  if (job.maxBudgetUsd) args.push(`--max-budget-usd ${job.maxBudgetUsd}`);
  if (job.resumeId) args.push(`--resume ${job.resumeId}`);
  if (job.allowedTools.length) args.push(`--allowedTools ${job.allowedTools.map((t) => `"${t}"`).join(' ')}`); // 可変長なので最後に置く
  return `${m[1]}${m[2]} ${args.join(' ')}`;
}

const jobs = createJobManager({
  shell: SHELL,
  resolveCwd,
  jobCommand: () => JOB_COMMAND,
  checkCommand: (cmd, cwd) => assertCommandExists(cmd, SHELL, cwd),
  buildCommand: buildJobCommand,
  envFor: (job) => ({ ...process.env, GALAXY_SESSION: job.id, GALAXY_PORT: String(PORT), GALAXY_TOKEN: HOOK_TOKEN }),
  getMaxConcurrent: () => settings.maxConcurrentJobs,
  onChange: (j) => broadcast('job', j),
  onRemove: (id) => broadcast('job-removed', { id }),
  onFinish: (j) => {
    cancelPermissions(j.id);
    removeMcpConfig(j.id);
    // 登録したエージェントに結果を知らせる(メッセージとして)
    if (j.parent && j.source === 'agent') {
      const text = `ジョブ ${j.id}「${j.name}」が${j.status === 'done' ? '完了' : `終了(${j.status})`}しました。` +
        `${j.result ? `\n結果:\n${j.result.slice(0, 4000)}` : ''}${j.error ? `\nエラー: ${j.error}` : ''}`;
      try { bus.send({ from: j.id, fromName: j.name, to: j.parent, toName: agentName(j.parent), text }); } catch (_) { /* ignore */ }
    }
  },
});

const automations = createAutomations({
  resolveCwd,
  submit: (t, meta) => jobs.create(t, { ...meta, defaultCwd: t.cwd }),
  isActive: (id) => { const j = jobs.get(id); return !!j && (j.status === 'queued' || j.status === 'running'); },
  jobEndedAt: (id) => jobs.get(id)?.endedAt || null,
  onChange: (a) => broadcast('automation', a),
  onRemove: (id) => broadcast('automation-removed', { id }),
});

// ---- 共有バス(エージェント間のメッセージ・共有メモリ)----
let boardTimer = null;
const bus = createBus({
  onChange: () => {
    // 未読数の変化をセッション表示に反映し、ボード画面に更新を知らせる(まとめて)
    if (boardTimer) return;
    boardTimer = setTimeout(() => {
      boardTimer = null;
      broadcast('board', { unreadUser: bus.unreadCount('user') });
      for (const s of sessions.values()) emit(s);
    }, 200);
  },
});

function agentName(id) {
  if (id === 'user') return 'あなた';
  if (id === 'all') return '全員';
  const s = sessions.get(id);
  if (s) return s.name;
  const j = jobs.get(id);
  return j ? j.name : id;
}

function agentList() {
  return [
    ...[...sessions.values()].filter((s) => s.alive).map((s) => ({
      id: s.id, kind: 'session', name: s.name, cwd: s.cwd, status: s.status, detail: s.statusDetail,
    })),
    ...jobs.list().filter((j) => j.status === 'queued' || j.status === 'running').map((j) => ({
      id: j.id, kind: 'job', name: j.name, cwd: j.cwd, status: j.status, parent: j.parent,
    })),
  ];
}

// 宛先の解決: ID / 名前(大文字小文字を区別しない)/ user / all / parent
function resolveAgent(to, from) {
  const t = String(to || '').trim();
  if (!t) throw new Error('宛先を指定してください');
  if (t === 'user' || t === 'all') return t;
  if (t === 'parent') {
    const j = jobs.get(from);
    if (!j || !j.parent) throw new Error('あなたを登録したエージェントはいません');
    return j.parent;
  }
  if (sessions.has(t) || jobs.get(t)) return t;
  const low = t.toLowerCase();
  const hit = agentList().find((a) => a.name.toLowerCase() === low) ||
    [...sessions.values()].find((s) => s.name.toLowerCase() === low);
  if (!hit) throw new Error(`宛先が見つかりません: ${t}(list_agents で確認してください)`);
  return hit.id;
}

const jobSummary = (j) => ({
  id: j.id, name: j.name, status: j.status, parent: j.parent, cwd: j.cwd, createdAt: j.createdAt, endedAt: j.endedAt,
  costUsd: j.costUsd, result: j.result, error: j.error, lastText: j.status === 'running' ? j.lastText : undefined,
});
const msgOut = (m) => ({ id: m.id, from: m.from, fromName: m.fromName, to: m.to, text: m.text, at: new Date(m.at).toISOString(), replyTo: m.replyTo });

// 入力待ちの対話セッションに、文章を貼り付けて送信する(ブラケットペーストで複数行もまとめて入る)
function typeInto(s, text) {
  s.proc.write(`\x1b[200~${text.replace(/\x1b/g, '')}\x1b[201~`);
  setTimeout(() => { if (s.alive) s.proc.write('\r'); }, 150);
}

// MCP サーバー(mcp-bus.js)からのツール呼び出し
async function busCall(from, tool, a) {
  const me = sessions.get(from) || jobs.get(from);
  if (!me) throw new Error('呼び出し元のエージェントが見つかりません');
  const myName = agentName(from);
  switch (tool) {
    case 'whoami': {
      const j = jobs.get(from);
      return { id: from, name: myName, kind: j ? 'job' : 'session', parent: j ? j.parent : null };
    }
    case 'list_agents':
      return { you: from, agents: agentList(), note: 'メッセージは ID か名前で送れます。"user" はこのアプリを使っている人です。' };
    case 'send_message': {
      const to = resolveAgent(a.to, from);
      const m = bus.send({ from, fromName: myName, to, toName: agentName(to), text: a.text, replyTo: typeof a.reply_to === 'string' ? a.reply_to : null });
      return { sent: m.id, to, toName: m.toName };
    }
    case 'read_messages':
      return bus.inbox(from, { unreadOnly: !a.include_read }).map(msgOut);
    case 'send_prompt': {
      const to = resolveAgent(a.to, from);
      const s = sessions.get(to);
      if (!s || !s.alive) throw new Error('送り先は実行中の対話セッションにしてください');
      if (to === from) throw new Error('自分には送れません');
      if (!['idle', 'done'].includes(s.status)) throw new Error(`相手は今「${s.status}」なので送れません。send_message で送ってください`);
      const text = String(a.text || '').trim().slice(0, 20000);
      if (!text) throw new Error('本文が空です');
      bus.send({ from, fromName: myName, to, toName: s.name, text: `(プロンプトとして入力)\n${text}` });
      bus.inbox(to, { unreadOnly: true }); // 入力したものは既読扱い
      typeInto(s, `[${myName} (${from}) から] ${text}`);
      return { typedInto: to };
    }
    case 'submit_job': {
      const depth = (jobs.get(from)?.depth || 0) + 1;
      if (depth > MAX_AGENT_DEPTH) throw new Error(`ジョブからジョブを登録できるのは ${MAX_AGENT_DEPTH} 段までです`);
      const active = jobs.list().filter((j) => j.source === 'agent' && (j.status === 'queued' || j.status === 'running')).length;
      if (active >= MAX_AGENT_JOBS) throw new Error(`エージェントが登録した待ち・実行中のジョブが上限(${MAX_AGENT_JOBS})に達しています`);
      const j = jobs.create({
        prompt: a.prompt, name: a.name, cwd: a.cwd, model: a.model,
        permissionMode: a.permission_mode || '', priority: a.priority, maxBudgetUsd: a.max_budget_usd,
      }, { strict: true, source: 'agent', parent: from, depth, defaultCwd: me.cwd });
      return { id: j.id, name: j.name, status: j.status, note: '終わると結果があなた宛てのメッセージでも届きます。get_job で待つこともできます。' };
    }
    case 'get_job': {
      const j = await jobs.wait(String(a.id || ''), Math.min(240, Math.max(0, Number(a.wait_seconds) || 0)) * 1000);
      if (!j) throw new Error(`ジョブが見つかりません: ${a.id}`);
      return jobSummary(j);
    }
    case 'list_jobs':
      return jobs.list()
        .filter((j) => (!a.status || j.status === a.status) && (!a.mine || j.parent === from))
        .sort((x, y) => y.createdAt - x.createdAt).slice(0, 50)
        .map((j) => ({ ...jobSummary(j), result: j.result ? j.result.slice(0, 300) : '' }));
    case 'cancel_job': {
      const j = jobs.get(String(a.id || ''));
      if (!j) throw new Error('ジョブが見つかりません');
      if (j.parent !== from) throw new Error('自分が登録したジョブだけ中止できます');
      return { canceled: jobs.cancel(j.id) };
    }
    case 'memory_write':
      return bus.memWrite(a.key, a.value, { tags: a.tags, author: `${myName} (${from})` });
    case 'memory_read':
      return bus.memRead(String(a.key || '')) || { error: 'そのキーはありません' };
    case 'memory_search':
      return bus.memSearch(a.query, { prefix: typeof a.prefix === 'string' ? a.prefix : '' });
    case 'memory_delete':
      return { deleted: bus.memDelete(String(a.key || '')) };
    default:
      throw new Error(`unknown tool: ${tool}`);
  }
}

// ---- REST API ----
app.get('/api/sessions', (_req, res) => {
  res.json([...sessions.values()].map(publicInfo));
});

app.post('/api/sessions', (req, res) => {
  try {
    const { name, cwd, command, appId } = req.body || {};
    const s = createSession({ name, cwd, command, appId });
    res.status(201).json(publicInfo(s));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (typeof req.body?.name === 'string' && req.body.name.trim()) s.name = req.body.name.trim();
  emit(s);
  res.json(publicInfo(s));
});

app.delete('/api/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  clearTimeout(s.doneTimer);
  clearTimeout(s.actTimer);
  clearTimeout(s.usageTimer);
  cancelPermissions(s.id);
  const proc = s.proc;
  s.proc = null; // onExit を無視させる
  s.alive = false;
  if (proc) {
    try { proc.kill(); } catch (_) { /* ignore */ }
  }
  for (const ws of s.clients) ws.close();
  sessions.delete(s.id);
  store.removeLog(s.id);
  removeMcpConfig(s.id);
  persist();
  broadcast('removed', { id: s.id });
  res.status(204).end();
});

app.post('/api/sessions/:id/restart', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  try {
    restartSession(s, { resume: !!req.body?.resume });
    res.json(publicInfo(s));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/permissions', (_req, res) => res.json([...permissions.values()].map(permInfo)));

app.post('/api/permissions/:id', (req, res) => {
  const x = permissions.get(req.params.id);
  if (!x) return res.status(404).json({ error: 'この確認はもう終わっています' });
  const b = req.body || {};
  let decision;
  if (b.behavior === 'allow') {
    decision = { behavior: 'allow' };
    if (b.always) {
      const updates = x.suggestions.filter((u) => u.type === 'addRules' && u.behavior === 'allow');
      if (updates.length) decision.updatedPermissions = updates;
    }
  } else if (b.behavior === 'deny') {
    decision = { behavior: 'deny', message: typeof b.message === 'string' ? b.message.slice(0, 500) : '', interrupt: !!b.interrupt };
  } else {
    decision = { behavior: 'ask' }; // ターミナルの確認ダイアログで答える
  }
  resolvePermission(x.id, decision);
  res.status(204).end();
});

app.get('/api/settings', (_req, res) => res.json(settings));
app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  if (typeof b.permissionInbox === 'boolean') settings.permissionInbox = b.permissionInbox;
  if (typeof b.busEnabled === 'boolean') settings.busEnabled = b.busEnabled;
  if (Number.isFinite(b.maxConcurrentJobs)) settings.maxConcurrentJobs = Math.min(10, Math.max(1, Math.round(b.maxConcurrentJobs)));
  jobs.pump();
  try { store.saveSettings(settings); } catch (e) { return res.status(500).json({ error: e.message }); }
  if (!settings.permissionInbox) for (const x of [...permissions.values()]) resolvePermission(x.id, { behavior: 'ask' });
  broadcast('settings', settings);
  res.json(settings);
});

// ---- ジョブ ----
const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out === undefined) return res.status(204).end();
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
};

app.get('/api/jobs', wrap(() => ({ jobs: jobs.list(), maxConcurrent: settings.maxConcurrentJobs, command: JOB_COMMAND })));
app.post('/api/jobs', wrap((req) => jobs.create(req.body || {}, { source: 'ui' })));
app.post('/api/jobs/:id/cancel', wrap((req) => { jobs.cancel(req.params.id); }));
app.post('/api/jobs/:id/retry', wrap((req) => jobs.retry(req.params.id)));
app.delete('/api/jobs/:id', wrap((req) => { if (!jobs.remove(req.params.id)) throw new Error('見つかりません'); }));
app.get('/api/jobs/:id/transcript', wrap((req) => jobs.transcript(req.params.id)));
// ジョブの会話を、対話セッションとして開く(claude --resume)
app.post('/api/jobs/:id/open', wrap((req) => {
  const j = jobs.get(req.params.id);
  if (!j) throw new Error('見つかりません');
  if (!j.claudeSessionId) throw new Error('このジョブには Claude のセッション ID がありません');
  if (j.status === 'running') throw new Error('実行中のジョブは開けません(終わってから開いてください)');
  const cmd = isClaudeCommand(DEFAULT_COMMAND) ? DEFAULT_COMMAND : JOB_COMMAND;
  return publicInfo(createSession({ name: `${j.name} (${j.id})`, cwd: j.cwd, command: cmd, resumeId: j.claudeSessionId }));
}));

// ---- オートメーション ----
app.get('/api/automations', wrap(() => automations.list()));
app.post('/api/automations', wrap((req) => automations.create(req.body || {})));
app.put('/api/automations/:id', wrap((req) => {
  const a = automations.update(req.params.id, req.body || {});
  if (!a) throw new Error('見つかりません');
  return a;
}));
app.delete('/api/automations/:id', wrap((req) => { if (!automations.remove(req.params.id)) throw new Error('見つかりません'); }));
app.post('/api/automations/:id/run', wrap((req) => automations.run(req.params.id)));

// ---- ボード(メッセージと共有メモリを人が見る・書く)----
app.get('/api/board', wrap(() => ({
  messages: bus.messages(),
  memory: bus.memSearch('', { limit: 2000 }),
  unreadUser: bus.unreadCount('user'),
  agents: agentList(),
})));
app.post('/api/board/messages', wrap((req) => {
  const b = req.body || {};
  const to = resolveAgent(b.to, 'user');
  const m = bus.send({ from: 'user', fromName: 'あなた', to, toName: agentName(to), text: b.text });
  // 待機中の対話セッション宛てなら、そのままプロンプトとして入力することもできる
  if (b.asPrompt) {
    const s = sessions.get(to);
    if (!s || !s.alive) throw new Error('プロンプトとして送れるのは実行中の対話セッションだけです');
    typeInto(s, b.text);
    bus.inbox(to, { unreadOnly: true });
  }
  return m;
}));
app.post('/api/board/read', wrap(() => { bus.inbox('user', { unreadOnly: true }); }));
app.delete('/api/board/messages', wrap(() => { bus.clearMessages(); }));
app.put('/api/board/memory', wrap((req) => {
  const b = req.body || {};
  return bus.memWrite(b.key, b.value, { tags: b.tags, author: 'あなた' });
}));
app.delete('/api/board/memory', wrap((req) => { if (!bus.memDelete(String(req.query.key || ''))) throw new Error('見つかりません'); }));

app.get('/api/defaults', (_req, res) => {
  // ホーム画面(グラフ)のルート候補: ホーム、このアプリの親フォルダ、いま動いているセッションの作業フォルダ
  const suggested = [os.homedir(), path.dirname(__dirname), ...[...sessions.values()].map((s) => s.cwd)];
  res.json({ command: DEFAULT_COMMAND, cwd: os.homedir(), suggestedRoots: [...new Set(suggested)] });
});

// フォルダ構造グラフ(親子 / import 依存)。読み取り専用。
app.post('/api/graph', async (req, res) => {
  try {
    const b = req.body || {};
    const roots = Array.isArray(b.roots) ? b.roots.filter((x) => typeof x === 'string') : [];
    const focus = typeof b.focus === 'string' && b.focus ? b.focus : null;
    if (!focus && !roots.length) return res.status(400).json({ error: 'roots か focus を指定してください' });
    res.json(await buildGraph({
      roots, focus, depth: b.depth, hidden: !!b.hidden, includeIgnored: !!b.includeIgnored, imports: !!b.imports,
    }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- アプリ一覧(Web アプリ / コマンドアプリ) ----
app.get('/api/apps', (_req, res) => res.json({ appsPort: APPS_PORT, apps: appsStore.list() }));
app.post('/api/apps', (req, res) => {
  try { res.status(201).json(appsStore.create(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/apps/:id', (req, res) => {
  try {
    const a = appsStore.update(req.params.id, req.body || {});
    if (!a) return res.status(404).json({ error: 'not found' });
    res.json(a);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/apps/:id', (req, res) => {
  if (!appsStore.remove(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});
// ローカルの Web アプリ(HTML ファイル / フォルダ)は別ポート(APPS_PORT)で配信する。
// 本体とはオリジンが違うので、アプリ側から本体の /api や /ws を呼んでも Origin チェックで拒否される。
const appsServer = express();
appsServer.disable('x-powered-by');
appsServer.use((req, res, next) => {
  const host = (req.headers.host || '').split(':')[0];
  if (host !== 'localhost' && host !== '127.0.0.1') return res.status(403).end('forbidden');
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();
  next();
});
appsServer.use('/appfiles/:id', (req, res, next) => {
  const handler = appsStore.staticHandler(req.params.id);
  if (!handler) return res.status(404).end('not found');
  res.setHeader('Cache-Control', 'no-store');
  // 本体の画面からだけ iframe 表示を許す
  res.setHeader('Content-Security-Policy', `frame-ancestors http://localhost:${PORT} http://127.0.0.1:${PORT}`);
  handler(req, res, next);
});

function hookAuth(req) {
  const token = req.headers['x-galaxy-token'];
  return typeof token === 'string' && token.length === HOOK_TOKEN.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(HOOK_TOKEN));
}

// hook.js からのイベント受信(トークン必須)
app.post('/api/hook', (req, res) => {
  if (!hookAuth(req)) return res.status(401).end();
  const s = sessions.get(req.body?.sessionId);
  if (s && s.alive && req.body.payload && typeof req.body.payload === 'object') {
    applyHook(s, req.body.payload);
  }
  res.status(204).end();
});

// mcp-bus.js からのツール呼び出し(トークン必須。from は起動時に渡したエージェント ID)
app.post('/api/bus', async (req, res) => {
  if (!hookAuth(req)) return res.status(401).end();
  const b = req.body || {};
  try {
    const result = await busCall(String(b.from || ''), String(b.tool || ''), b.args && typeof b.args === 'object' ? b.args : {});
    res.json({ result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// hook.js からの権限確認。受信箱で決まるまで応答を保留する(long poll)
app.post('/api/permission', (req, res) => {
  if (!hookAuth(req)) return res.status(401).end();
  const agentId = req.body?.sessionId;
  const s = sessions.get(agentId);
  const isJob = !s && jobs.isRunning(agentId); // ジョブ(claude -p)の確認も受信箱へ。答えがなければ拒否になる
  const p = req.body?.payload;
  if ((!isJob && (!s || !s.alive)) || !p || typeof p !== 'object' || !settings.permissionInbox) {
    return res.json({ behavior: 'ask' });
  }
  if (s) trackTranscript(s, p);
  const id = `p${++permSeq}`;
  const now = Date.now();
  const x = {
    id,
    sessionId: agentId,
    at: now,
    expiresAt: now + PERMISSION_WAIT * 1000,
    tool: typeof p.tool_name === 'string' ? p.tool_name : '?',
    mcpServer: typeof p.mcp_server === 'string' ? p.mcp_server : '',
    agentId: p.agent_id || null,
    agentType: typeof p.agent_type === 'string' ? p.agent_type : '',
    input: p.input && typeof p.input === 'object' ? p.input : {},
    suggestions: Array.isArray(p.permission_suggestions) ? p.permission_suggestions.filter((u) => u && typeof u === 'object') : [],
    res,
    timer: null,
  };
  x.timer = setTimeout(() => resolvePermission(id, { behavior: 'ask' }), PERMISSION_WAIT * 1000);
  // hook 側が先に終わった(Claude 側で中断された等)ら片付ける
  res.on('close', () => { if (permissions.has(id)) resolvePermission(id, { behavior: 'ask' }); });
  permissions.set(id, x);
  broadcast('permission', permInfo(x));
  if (s) {
    setStatus(s, 'waiting', `${x.tool} の許可待ち`);
    emit(s);
  }
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ---- WebSocket (1接続 = 1セッションの画面) ----
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // 他サイトからの WebSocket 乗っ取り(CSWSH)対策: Origin がローカルのときだけ許可
  const origin = req.headers.origin;
  if (origin && !OK_ORIGINS.includes(origin)) {
    socket.destroy();
    return;
  }
  const m = /^\/ws\/(s\d+)$/.exec(req.url || '');
  const session = m && sessions.get(m[1]);
  if (!session) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    session.clients.add(ws);
    // 再接続時に直近の出力を再生
    if (session.buffer) ws.send(JSON.stringify({ type: 'output', data: session.buffer, replay: true }));
    if (!session.alive) ws.send(JSON.stringify({ type: 'exit', exitCode: session.exitCode }));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (!session.alive) return;
      if (msg.type === 'input' && typeof msg.data === 'string') {
        session.proc.write(msg.data);
      } else if (msg.type === 'resize') {
        const cols = Math.max(2, Math.min(500, msg.cols | 0));
        const rows = Math.max(2, Math.min(200, msg.rows | 0));
        try { session.proc.resize(cols, rows); } catch (_) { /* ignore */ }
      }
    });
    ws.on('close', () => session.clients.delete(ws));
  });
});

writeHookSettings();
// 前回の起動で残った MCP 設定(トークン入り)を消す
for (const f of fs.readdirSync(TMP_DIR)) if (f.startsWith(`mcp-${PORT}-`)) removeMcpConfig(f.slice(`mcp-${PORT}-`.length, -5));
restoreSessions();
server.listen(PORT, HOST, () => {
  console.log(`Claude Galaxy: http://localhost:${PORT}`);
  jobs.pump(); // 前回から待ちのまま残っているジョブを始める
});
http.createServer(appsServer).listen(APPS_PORT, HOST)
  .on('error', (e) => console.error(`ローカル Web アプリ用ポート ${APPS_PORT} を開けません(${e.code})。APPS_PORT で変更できます。`));

function shutdown() {
  shuttingDown = true;
  persist({ now: true });
  for (const x of [...permissions.values()]) resolvePermission(x.id, { behavior: 'ask' });
  for (const s of sessions.values()) {
    if (s.alive) { try { s.proc.kill(); } catch (_) { /* ignore */ } }
  }
  jobs.shutdown();
  for (const f of fs.readdirSync(TMP_DIR)) if (f.startsWith(`mcp-${PORT}-`)) removeMcpConfig(f.slice(`mcp-${PORT}-`.length, -5));
  store.closeAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
