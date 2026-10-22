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
const SETTINGS_FILE = path.join(os.tmpdir(), 'claude-multi-term', `hooks-${PORT}.json`);
const fwd = (p) => p.replace(/\\/g, '/'); // bash / PowerShell / cmd のどれでも通るよう / 区切りにする

// このアプリで起動した claude にだけ渡す(--settings)。ユーザーの settings.json は書き換えない。
function writeHookSettings() {
  const hooks = {};
  for (const ev of HOOK_EVENTS) {
    hooks[ev] = [{
      hooks: [{ type: 'command', command: `node "${fwd(HOOK_JS)}" ${ev}`, async: true, timeout: 5 }],
    }];
  }
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ hooks }, null, 2));
}

const CLAUDE_SUBCOMMANDS = new Set([
  'update', 'install', 'doctor', 'mcp', 'plugin', 'plugins', 'auth', 'agents', 'attach', 'logs',
  'rm', 'stop', 'kill', 'respawn', 'daemon', 'remote-control', 'setup-token', 'purge', 'import',
  'gateway', 'ultrareview', 'auto-mode', 'self-hosted-runner',
]);

// 起動コマンドが claude の対話起動なら、先頭語の直後に --settings を差し込む
function injectSettings(cmdline) {
  const m = /^("[^"]+"|\S+)([\s\S]*)$/.exec(cmdline.trim());
  if (!m) return { cmd: cmdline, injected: false };
  const first = m[1].replace(/^"|"$/g, '');
  const base = path.basename(first.replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  if (base !== 'claude') return { cmd: cmdline, injected: false };
  const rest = m[2];
  if (/(^|\s)--settings(\s|=)/.test(rest)) return { cmd: cmdline, injected: false }; // 利用者が自分で指定済み
  const next = rest.trim().split(/\s+/)[0];
  if (next && CLAUDE_SUBCOMMANDS.has(next)) return { cmd: cmdline, injected: false };
  return { cmd: `${m[1]} --settings "${fwd(SETTINGS_FILE)}"${rest}`, injected: true };
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
      const a = ensureAgent(s, p.agent_id || `sub-${now}`, p.agent_type);
      a.status = 'done';
      a.endedAt = now;
      if (p.last_assistant_message) a.summary = p.last_assistant_message.slice(0, 160);
      break;
    }

    case 'SessionEnd':
      for (const a of s.agents) if (a.status === 'running') { a.status = 'stopped'; a.endedAt = now; }
      setStatus(s, 'idle');
      break;

    default:
      return;
  }
  emit(s);
}

function createSession({ name, cwd, command, appId }) {
  const id = `s${++seq}`;
  const workdir = resolveCwd(cwd);
  const cmdline = (command || DEFAULT_COMMAND).trim();
  const shell = IS_WIN ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/bash');
  assertCommandExists(cmdline, shell, workdir);

  const { cmd: finalCmd, injected } = injectSettings(cmdline);

  // Windows: cmd.exe /c で実行(claude.cmd / claude.exe を PATHEXT で解決。終了すると PTY も閉じる)。
  //   引数は文字列で渡して node-pty に余計なクォートをさせない。
  // Unix: ログインシェル経由で PATH(nvm等)を引き継ぎ、終了後にシェルが残らないよう exec する
  const spawnArgs = IS_WIN ? `/d /s /c "${finalCmd}"` : ['-l', '-c', `exec ${finalCmd}`];
  const proc = pty.spawn(shell, spawnArgs, {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd: workdir,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      MULTI_TERM_SESSION: id,
      MULTI_TERM_PORT: String(PORT),
      MULTI_TERM_TOKEN: HOOK_TOKEN,
    },
  });

  const session = {
    id,
    name: name || `session-${seq}`,
    cwd: workdir,
    command: cmdline,
    appId: typeof appId === 'string' && appsStore.get(appId) ? appId : null,
    createdAt: Date.now(),
    alive: true,
    exitCode: null,
    proc,
    buffer: '',
    clients: new Set(),
    // 状態
    injected,
    hooked: false,
    status: 'starting',
    statusDetail: '',
    statusSince: Date.now(),
    agents: [],
    pendingAgents: [],
    doneTimer: null,
    actTimer: null,
  };

  proc.onData((data) => {
    session.buffer += data;
    if (session.buffer.length > SCROLLBACK_LIMIT) {
      session.buffer = session.buffer.slice(-SCROLLBACK_LIMIT);
    }
    for (const ws of session.clients) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data }));
    }
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
    session.alive = false;
    session.exitCode = exitCode;
    clearTimeout(session.doneTimer);
    clearTimeout(session.actTimer);
    for (const a of session.agents) if (a.status === 'running') { a.status = 'stopped'; a.endedAt = Date.now(); }
    setStatus(session, 'exited', `code ${exitCode}`);
    for (const ws of session.clients) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', exitCode }));
    }
    emit(session);
  });

  sessions.set(id, session);
  emit(session);
  return session;
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
  if (s.alive) {
    try { s.proc.kill(); } catch (_) { /* ignore */ }
  }
  for (const ws of s.clients) ws.close();
  sessions.delete(s.id);
  broadcast('removed', { id: s.id });
  res.status(204).end();
});

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

// hook.js からのイベント受信(トークン必須)
app.post('/api/hook', (req, res) => {
  const token = req.headers['x-multi-term-token'];
  if (typeof token !== 'string' || token.length !== HOOK_TOKEN.length ||
      !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(HOOK_TOKEN))) {
    return res.status(401).end();
  }
  const s = sessions.get(req.body?.sessionId);
  if (s && s.alive && req.body.payload && typeof req.body.payload === 'object') {
    applyHook(s, req.body.payload);
  }
  res.status(204).end();
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
    if (session.buffer) ws.send(JSON.stringify({ type: 'output', data: session.buffer }));
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
server.listen(PORT, HOST, () => {
  console.log(`Claude Multi Term: http://localhost:${PORT}`);
});
http.createServer(appsServer).listen(APPS_PORT, HOST)
  .on('error', (e) => console.error(`ローカル Web アプリ用ポート ${APPS_PORT} を開けません(${e.code})。APPS_PORT で変更できます。`));

function shutdown() {
  for (const s of sessions.values()) {
    if (s.alive) { try { s.proc.kill(); } catch (_) { /* ignore */ } }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
