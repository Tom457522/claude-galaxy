'use strict';

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { buildGraph } = require('./graph');
const appsStore = require('./apps');
const store = require('./store');
const { UsageTracker, createUsageScanner, costFor } = require('./usage');
const { createJobManager } = require('./jobs');
const { createAutomations } = require('./automations');
const { createBus } = require('./bus');
const cmdline = require('./cmdline');
const { createAudit, targetOf } = require('./audit');
const gitx = require('./git');
const { createTools, claudeMcpServers, claudeExtensions } = require('./tools');
const dispatch = require('./dispatch');
const { createAgents } = require('./agents');
const { createBudget } = require('./budget');
const { createPlanMonitor } = require('./plan');
const { createCloudUsage } = require('./cloud');
const { diagnose } = require('./doctor');
const { search } = require('./search');

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

// macOS: npm で入れた node-pty の spawn-helper に実行権限が付かないことがあり、
// そのままだと「posix_spawnp failed」でセッションを起動できない。起動時に権限を直す
function ensurePtyHelper() {
  if (process.platform !== 'darwin') return;
  let dir;
  try { dir = path.dirname(require.resolve('node-pty/package.json')); } catch (_) { return; }
  const candidates = [path.join(dir, 'build', 'Release', 'spawn-helper')];
  try { for (const d of fs.readdirSync(path.join(dir, 'prebuilds'))) candidates.push(path.join(dir, 'prebuilds', d, 'spawn-helper')); } catch (_) { /* ignore */ }
  for (const f of candidates) {
    try {
      const st = fs.statSync(f);
      if (!(st.mode & 0o111)) fs.chmodSync(f, st.mode | 0o755);
    } catch (_) { /* ないものは飛ばす */ }
  }
}
ensurePtyHelper();
const SCROLLBACK_LIMIT = 200 * 1024; // 再接続時に再生するバッファ上限(文字数)

// ---- Claude Code hooks 連携 ----
// エージェント(セッション / ジョブ)ごとに別のトークンを渡す。hook.js / mcp-bus.js からの呼び出しは、
// トークンで「どのエージェントか」を決める(本文の ID は信じない。ほかのエージェントになりすませないように)
const agentTokens = new Map(); // token -> agent id
const tokenOf = new Map(); // agent id -> token
function tokenFor(id) {
  if (tokenOf.has(id)) return tokenOf.get(id);
  const t = crypto.randomBytes(24).toString('hex');
  tokenOf.set(id, t);
  agentTokens.set(t, id);
  return t;
}
function revokeToken(id) {
  const t = tokenOf.get(id);
  if (t) { agentTokens.delete(t); tokenOf.delete(id); }
}
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
const { fwd } = cmdline;

// 「止められた操作」(safety_event)を集めるときだけ、子の claude に OpenTelemetry のログを本体へ送らせる。
// 送り先は 127.0.0.1 のこのサーバーで、エージェントごとのトークンで呼び出し元を決める
function telemetryEnv(id) {
  if (!settings.collectSafetyEvents) return {};
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    // ユーザーの環境の OTEL_* でメトリクス・トレースが別の送り先へ出ないようにする
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_TRACES_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${PORT}/otel/v1/logs`,
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: `X-Galaxy-Token=${tokenFor(id)}`,
    OTEL_LOGS_EXPORT_INTERVAL: '2000',
  };
}

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
  // 承認ゲート(同期)。危ないコマンドなら受信箱で決まるまで待つ。
  // オフのときは登録しない(すべてのコマンド文字列を本体へ送らないため)。設定を変えたら書き直す
  if (settings.approvalGate) {
    hooks.PreToolUse.push({
      matcher: 'Bash|PowerShell',
      hooks: [{ type: 'command', command: `node "${fwd(HOOK_JS)}" PreToolUseGate`, timeout: PERMISSION_WAIT + 30 }],
    });
  }
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ hooks, permissions: { allow: BUS_AUTO_ALLOW } }, null, 2));
}

// エージェントごとの MCP 設定(共有バス)。トークンを含むので本人だけが読めるようにする
const mcpFile = (id) => path.join(TMP_DIR, `mcp-${PORT}-${id}.json`);
//   serverIds: 追加で渡す Galaxy 管理の MCP サーバー(null なら「既定で使う」もの)
function writeMcpConfig(id, serverIds = null) {
  const servers = tools.configFor(serverIds);
  if (settings.busEnabled) {
    servers.galaxy = {
      type: 'stdio',
      command: 'node',
      args: [fwd(MCP_JS)],
      env: { GALAXY_PORT: String(PORT), GALAXY_TOKEN: tokenFor(id), GALAXY_SESSION: id },
    };
  }
  if (!Object.keys(servers).length) return null;
  const file = mcpFile(id);
  const conf = { mcpServers: servers };
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(conf, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows */ }
  return file;
}
function removeMcpConfig(id) {
  try { fs.unlinkSync(mcpFile(id)); } catch (_) { /* ignore */ }
  try { fs.unlinkSync(memoryFile(id)); } catch (_) { /* ignore */ }
}

// 共有メモリから、最初に渡す内容(--append-system-prompt-file)を作る
//   query: 空白区切り。「tag:名前」はタグ、それ以外はキーの先頭か語の一致
const memoryFile = (id) => path.join(TMP_DIR, `memory-${PORT}-${id}.md`);
function writeMemoryPrompt(id, query) {
  const terms = String(query || '').split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  const picked = new Map();
  for (const t of terms) {
    const list = t.startsWith('tag:')
      ? bus.memSearch('', { limit: 2000 }).filter((m) => (m.tags || []).includes(t.slice(4)))
      : [...bus.memSearch('', { prefix: t, limit: 200 }), ...bus.memSearch(t, { limit: 200 })];
    for (const m of list) picked.set(m.key, m);
  }
  if (!picked.size) return null;
  let text = '# Claude Galaxy の共有メモリ(ほかのエージェントや人が残した知識)\n\n';
  for (const m of picked.values()) {
    const part = `## ${m.key}${m.tags && m.tags.length ? ` [${m.tags.join(', ')}]` : ''}\n${m.value}\n\n`;
    if (text.length + part.length > 30000) { text += '(多いため、ここまでにしました。続きは memory_search で探してください)\n'; break; }
    text += part;
  }
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(memoryFile(id), text, { mode: 0o600 });
  return memoryFile(id);
}

const SAFE_ID = cmdline.SAFE_ID;
const injectSettings = (cmd, resumeId, mcp, extra) => cmdline.injectSettings(cmd, { settingsFile: SETTINGS_FILE, resumeId, mcp, extra });

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
// 復元(バックアップの読み込み)だけは大きい本文を受け付ける
app.use((req, res, next) => (req.path === '/api/restore' ? express.json({ limit: '50mb' })(req, res, next) : express.json({ limit: '256kb' })(req, res, next)));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use('/vendor/addon-web-links', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links')));

/** @type {Map<string, any>} */
const sessions = new Map();
let seq = 0;
// 前回「復元」を選んでいたら、各データを読み込む前に反映する
const restoredFiles = store.applyPendingRestore();
if (restoredFiles.length) console.log(`バックアップから復元しました: ${restoredFiles.join(', ')}`);
let settings = store.loadSettings();
let shuttingDown = false;
const audit = createAudit({ getSettings: () => settings });
let auditTimer = null;
audit.onEntry(() => { // 記録タブに「増えた」とだけ知らせる(まとめて)
  if (auditTimer) return;
  auditTimer = setTimeout(() => { auditTimer = null; broadcast('audit', {}); }, 1000);
});
const tools = createTools();
// クラウドセッション(claude.ai/code など)の使用量。使用量タブと 1 日の予算に混ぜる
const cloud = createCloudUsage({ onChange: () => { budget.check(); broadcast('cloud', cloud.status()); } });
const usageScan = createUsageScanner({ extra: () => cloud.messages() });
const budget = createBudget({
  getSettings: () => settings,
  getCloud: (day) => cloudCostByDay(day),
  // level: 'warn'(8 割)/ 'over'(上限)に初めて達したとき。画面でデスクトップ通知を出す
  onChange: (st, level) => { broadcast('budget', { ...st, level }); if (level) jobs.pump(); },
});
// クラウドの応答をその日(ローカル時刻)の額にまとめる。予算の判定で毎回呼ばれるので、クラウドを読み直したときだけ作り直す
let cloudDays = null;
let cloudDaysAt = -1;
function cloudCostByDay(day) {
  const at = cloud.status().fetchedAt;
  if (!cloudDays || cloudDaysAt !== at) {
    cloudDays = new Map();
    cloudDaysAt = at;
    for (const { m } of cloud.messages()) {
      const d = new Date(m.t);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      cloudDays.set(k, (cloudDays.get(k) || 0) + (costFor(m) ?? 0));
    }
  }
  return cloudDays.get(day) || 0;
}
// プランの実際の利用率(5 時間・週間)。しきい値に達したらジョブを待たせ、下がったら再開する
const plan = createPlanMonitor({
  getSettings: () => settings,
  onChange: (st, level, hit) => {
    const { history, ...rest } = st; // 推移は画面が /api/plan で読む
    broadcast('plan', { ...rest, level, hit: hit && hit.kind });
    jobs.pump();
  },
});

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
  worktree: s.worktree,
  mcpServers: s.mcpServers,
  memory: s.memory,
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
  worktree: s.worktree,
  mcpServers: s.mcpServers,
  memory: s.memory || '',
  // セッションごとの警告額を超えたら画面で目立たせる
  costWarn: !!settings.budgetSessionWarnUsd && (s.usage.totals.cost || 0) >= settings.budgetSessionWarnUsd,
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
  if (ev === 'PostToolUse') {
    audit.log({
      agent: s.id, agentName: s.name, kind: 'tool', tool: p.tool_name, target: p.target, cwd: s.cwd,
      detail: inSub ? `サブエージェント ${p.agent_type || ''}` : '',
    });
  }
  s.pendingAgents = s.pendingAgents.filter((x) => now - x.at < 60000);

  switch (ev) {
    case 'SessionStart':
      setStatus(s, 'idle');
      sendPendingPrompt(s);
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
const isClaudeCommand = cmdline.isClaudeCommand;

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
      if (s.usage.refresh()) {
        // 増えた分を今日の使用額に足す(予算)
        const cost = s.usage.totals.cost || 0;
        // 会話を再開したセッションは、最初の集計で前回までの分が入るので、それは今日の使用額に数えない
        if (s.skipFirstCost) { s.skipFirstCost = false; s.lastCost = cost; }
        if (cost > (s.lastCost || 0)) budget.add('sessions', cost - (s.lastCost || 0));
        s.lastCost = cost;
        emit(s);
        persist();
      }
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
    worktree: null, // { repo, path, cwd, branch, base, origCwd }
    mcpServers: null, // 追加の MCP サーバー(null なら既定)
    pendingPrompt: '', // 起動したら最初に入力するプロンプト(窓口から)
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

  revokeToken(session.id); // 起動し直すたびに新しいトークンにする
  const claudeCmd = isClaudeCommand(session.command);
  const mcp = claudeCmd ? writeMcpConfig(session.id, session.mcpServers) : null;
  const mem = claudeCmd ? writeMemoryPrompt(session.id, session.memory) : null;
  const extra = mem ? `--append-system-prompt-file "${fwd(mem)}"` : '';
  const { cmd: finalCmd, injected, resumed } = injectSettings(session.command, resume ? session.claudeSessionId : null, mcp, extra);
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
      GALAXY_TOKEN: tokenFor(session.id),
      ...telemetryEnv(session.id),
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
    audit.log({ agent: session.id, agentName: session.name, kind: 'session-exit', detail: `code ${exitCode}`, cwd: session.cwd });
    for (const ws of session.clients) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', exitCode }));
    }
    scheduleUsage(session, 300);
    emit(session);
    persist();
  });
}

function createSession({ name, cwd, command, appId, resumeId, worktree, mcpServers, prompt, memory }) {
  const id = `s${++seq}`;
  const session = newSessionObject({
    id,
    name: name || `session-${seq}`,
    cwd: resolveCwd(cwd),
    command: (command || DEFAULT_COMMAND).trim(),
    appId,
  });
  if (resumeId) { session.claudeSessionId = resumeId; session.skipFirstCost = true; }
  if (Array.isArray(mcpServers)) session.mcpServers = mcpServers.filter((x) => typeof x === 'string');
  if (typeof prompt === 'string' && prompt.trim()) session.pendingPrompt = prompt.trim().slice(0, 20000);
  if (typeof memory === 'string') session.memory = memory.trim().slice(0, 500);
  // 別ブランチの作業コピー(worktree)で起動する
  if (worktree) {
    const wt = gitx.createWorktree(session.cwd, id, settings.worktreeDir);
    session.worktree = { ...wt, origCwd: session.cwd };
    session.cwd = wt.cwd;
  }
  try {
    spawnSession(session, { resume: !!resumeId });
  } catch (e) {
    if (session.worktree) { try { gitx.removeWorktree(session.worktree, { force: true }); } catch (_) { /* ignore */ } }
    throw e;
  }
  sessions.set(id, session);
  audit.log({
    agent: id, agentName: session.name, kind: 'session-start', cwd: session.cwd,
    detail: [session.command, session.worktree && `worktree ${session.worktree.branch}`, resumeId && `resume ${resumeId}`].filter(Boolean).join(' / '),
  });
  emit(session);
  persist();
  // 通常は SessionStart(hook)で入力する。hook が来ない場合に備えて、少し待ってからも入力する(1 回だけ)
  if (session.pendingPrompt) setTimeout(() => sendPendingPrompt(session), session.injected ? 8000 : 3000);
  return session;
}

// 窓口から起動したセッションに、最初のプロンプトを入力する
function sendPendingPrompt(s) {
  const text = s.pendingPrompt;
  if (!text || !s.alive) return;
  s.pendingPrompt = '';
  setTimeout(() => { if (s.alive) typeInto(s, text); }, 800);
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
    if (r.worktree && typeof r.worktree === 'object') s.worktree = r.worktree;
    if (Array.isArray(r.mcpServers)) s.mcpServers = r.mcpServers;
    if (typeof r.memory === 'string') s.memory = r.memory;
    s.lastCost = s.usage.totals.cost || 0; // 前回までの分は今日の使用額に数えない
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
  gate: x.gate || '', // 承認ゲートで止めたときは一致したパターン
  // 「今後も許可」できるのは、許可ルールの追加提案があるときだけ
  rules: x.suggestions.flatMap((u) => (u.type === 'addRules' && u.behavior === 'allow' && Array.isArray(u.rules)
    ? u.rules.map((r) => ({ tool: r.toolName, rule: r.ruleContent || '', destination: u.destination }))
    : [])),
});

// why: 'user'(受信箱で答えた)/ 'timeout'(待ち時間切れ)のときは監査ログに残す
function resolvePermission(id, decision, why = '') {
  const x = permissions.get(id);
  if (!x) return false;
  permissions.delete(id);
  clearTimeout(x.timer);
  if (!x.res.writableEnded) x.res.json(decision);
  if (why) {
    const label = { allow: decision.updatedPermissions ? '許可(今後も)' : '許可', deny: '拒否', ask: why === 'timeout' ? '時間切れ' : 'ターミナルで回答' }[decision.behavior];
    audit.log({ agent: x.sessionId, agentName: agentName(x.sessionId), kind: 'permission', tool: x.tool, target: targetOf(x.input), detail: label });
  }
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
  const mcp = writeMcpConfig(job.id, job.mcpServers);
  if (mcp) args.push(`--mcp-config "${fwd(mcp)}"`);
  args.push(`--settings "${fwd(SETTINGS_FILE)}"`);
  if (job.model) args.push(`--model ${job.model}`);
  if (job.permissionMode) args.push(`--permission-mode ${job.permissionMode}`);
  const jobBudget = job.maxBudgetUsd || Number(settings.budgetJobUsd) || 0; // 指定がなければ既定の上限
  if (jobBudget) args.push(`--max-budget-usd ${jobBudget}`);
  const mem = writeMemoryPrompt(job.id, job.memory);
  if (mem) args.push(`--append-system-prompt-file "${fwd(mem)}"`);
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
  envFor: (job) => ({ ...process.env, GALAXY_SESSION: job.id, GALAXY_PORT: String(PORT), GALAXY_TOKEN: tokenFor(job.id), ...telemetryEnv(job.id) }),
  getMaxConcurrent: () => settings.maxConcurrentJobs,
  blockReason: () => budget.blockReason() || plan.blockReason(),
  onChange: (j) => broadcast('job', j),
  onRemove: (id) => broadcast('job-removed', { id }),
  // 起動直前: worktree を指定されていれば作り、その中で動かす
  prepare: (j) => {
    if (j.worktree && !j.worktreeInfo) {
      const wt = gitx.createWorktree(j.cwd, j.id, settings.worktreeDir);
      j.worktreeInfo = { ...wt, origCwd: j.cwd };
      j.cwd = wt.cwd;
    }
    audit.log({
      agent: j.id, agentName: j.name, kind: 'job-start', cwd: j.cwd,
      detail: [j.model, j.permissionMode, j.worktreeInfo && `worktree ${j.worktreeInfo.branch}`, j.source !== 'ui' && `${j.source}${j.parent ? ` ${j.parent}` : ''}`].filter(Boolean).join(' / '),
    });
  },
  onToolUse: (j, name, input) => audit.log({ agent: j.id, agentName: j.name, kind: 'tool', tool: name, target: targetOf(input), cwd: j.cwd }),
  onFinish: (j) => {
    cancelPermissions(j.id);
    removeMcpConfig(j.id);
    revokeToken(j.id);
    if (j.costUsd) budget.add('jobs', j.costUsd);
    automations.onJobFinished(j);
    audit.log({
      agent: j.id, agentName: j.name, kind: 'job-end', cwd: j.cwd,
      detail: `${j.status}${j.costUsd ? ` $${j.costUsd.toFixed(4)}` : ''}${j.error ? ` ${j.error.slice(0, 200)}` : ''}`,
    });
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

const { agentName, agentList, resolveAgent, typeInto, busCall } = createAgents({
  sessions, jobs, bus, maxDepth: MAX_AGENT_DEPTH, maxAgentJobs: MAX_AGENT_JOBS,
});

// 一覧から消すときの worktree の片付け: 変更が残っていなければ消す(ブランチは残す)。残っていれば触らない
function cleanupWorktree(id, name, wt) {
  if (!wt || wt.removed) return;
  try {
    gitx.removeWorktree(wt);
    audit.log({ agent: id, agentName: name, kind: 'worktree-remove', target: wt.path, detail: `一覧から削除したため(branch ${wt.branch} は残しました)` });
  } catch (e) {
    audit.log({ agent: id, agentName: name, kind: 'worktree-remove', target: wt.path, detail: `変更が残っているため残しました: ${e.message.slice(0, 120)}` });
  }
}


const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out === undefined) return res.status(204).end();
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
};

// claude コマンドを 1 回だけ実行して出力を返す(ジョブと同じく、ログインシェル経由で PATH を引き継ぐ)
function runClaude(args, { cwd, input = '', timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const cmd = `${JOB_COMMAND} ${args}`;
    const proc = IS_WIN
      ? spawn(SHELL, ['/d', '/s', '/c', `"${cmd}"`], { cwd, windowsVerbatimArguments: true, windowsHide: true })
      : spawn(SHELL, ['-l', '-c', `exec ${cmd}`], { cwd });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch (_) { /* ignore */ } reject(new Error(`${Math.round(timeoutMs / 1000)} 秒以内に終わりませんでした`)); }, timeoutMs);
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { err += c; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    proc.stdin.on('error', () => { /* ignore */ });
    proc.stdin.end(input);
  });
}


let permSeq = 0;
const nextPermId = () => `p${++permSeq}`;

// ---- REST API(routes/ に分けている)----
const ctx = {
  app, wrap, sessions, settings, jobs, automations, bus, audit, tools, gitx, store, appsStore, dispatch,
  permissions, permInfo, resolvePermission, cancelPermissions, nextPermId,
  createSession, restartSession, publicInfo, emit, persist, setStatus, applyHook, trackTranscript,
  removeMcpConfig, cleanupWorktree, broadcast, sseClients, resolveCwd, isClaudeCommand, assertCommandExists,
  agentName, agentList, resolveAgent, typeInto, busCall, hookAuth, runClaude, buildGraph,
  claudeMcpServers, claudeExtensions, targetOf,
  budget, plan, cloud, usageScan, diagnose, search, onDiagHook, waitDiagHook, tokenFor, revokeToken, writeMemoryPrompt,
  writeHookSettings, HOOK_JS, MCP_JS, TMP_DIR, SETTINGS_FILE, PORT,
  DEFAULT_COMMAND, JOB_COMMAND, SHELL, IS_WIN, PERMISSION_WAIT, APPS_PORT, ROOT_DIR: __dirname,
};
for (const r of ['sessions', 'jobs', 'board', 'ops', 'misc', 'agent-api', 'system']) require(`./routes/${r}`)(ctx);

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

// hook.js / mcp-bus.js からの呼び出しの認証。トークンからエージェント ID を返す(だめなら null)
function hookAuth(req) {
  const token = req.headers['x-galaxy-token'];
  return typeof token === 'string' && agentTokens.get(token) || null;
}

// 自己診断用: hook が届いたかを待つ
const diagWaiters = new Set();
function onDiagHook() { for (const fn of diagWaiters) fn(true); diagWaiters.clear(); }
function waitDiagHook(ms) {
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(t); diagWaiters.delete(done); resolve(v); };
    const t = setTimeout(() => done(false), ms);
    diagWaiters.add(done);
  });
}

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
setInterval(() => budget.check(), 60000).unref(); // 日付が変わったら上限を外す
server.listen(PORT, HOST, () => {
  console.log(`Claude Galaxy: http://localhost:${PORT}`);
  jobs.pump(); // 前回から待ちのまま残っているジョブを始める
  if (!process.env.GALAXY_NO_PLAN) { plan.start(); cloud.start(); } // テストでは本物の Anthropic に問い合わせない
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
  audit.close();
  for (const f of fs.readdirSync(TMP_DIR)) if (f.startsWith(`mcp-${PORT}-`)) removeMcpConfig(f.slice(`mcp-${PORT}-`.length, -5));
  store.closeAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
