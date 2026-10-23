'use strict';
// ツールの管理
//   - Galaxy が管理する MCP サーバー(~/.claude-galaxy/mcp-servers.json): 登録・接続確認と、
//     セッション / ジョブごとにどれを使うかの割り当て(--mcp-config で渡す)
//   - Claude Code 自身の MCP 設定(~/.claude.json・.mcp.json)と、skills / agents / commands の一覧(読むだけ)

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { DATA_DIR } = require('./store');

const FILE = path.join(DATA_DIR, 'mcp-servers.json');
const IS_WIN = process.platform === 'win32';
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const RESERVED = new Set(['galaxy']);

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function strMap(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, val] of Object.entries(v).slice(0, 50)) {
    if (/^[A-Za-z0-9_.-]{1,100}$/.test(k) && typeof val === 'string') out[k] = val.slice(0, 4000);
  }
  return out;
}

// "KEY=VALUE" の行(画面の入力)を連想配列に
function parsePairs(text, sep) {
  if (text && typeof text === 'object') return strMap(text);
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf(sep);
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + sep.length).trim();
  }
  return strMap(out);
}

function createTools() {
  let servers = [];
  try { servers = JSON.parse(fs.readFileSync(FILE, 'utf8')).servers || []; } catch (_) { servers = []; }
  servers = servers.filter((s) => s && /^m[0-9a-f]+$/.test(s.id));

  function save() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ servers }, null, 2), { mode: 0o600 }); // env やヘッダーに秘密が入りうる
    fs.renameSync(tmp, FILE);
    try { fs.chmodSync(FILE, 0o600); } catch (_) { /* Windows */ }
  }

  function validate(input, prev = {}) {
    const type = ['stdio', 'http', 'sse'].includes(input.type) ? input.type : (prev.type || 'stdio');
    const s = {
      id: prev.id || `m${crypto.randomBytes(4).toString('hex')}`,
      name: str(input.name, 40) || prev.name,
      desc: str(input.desc, 200),
      type,
      command: type === 'stdio' ? str(input.command, 500) : '',
      args: type === 'stdio' ? (Array.isArray(input.args) ? input.args : String(input.args || '').split('\n'))
        .map((a) => String(a).trim()).filter(Boolean).slice(0, 50) : [],
      env: type === 'stdio' ? parsePairs(input.env, '=') : {},
      url: type !== 'stdio' ? str(input.url, 1000) : '',
      headers: type !== 'stdio' ? parsePairs(input.headers, ':') : {},
      defaultOn: input.defaultOn === undefined ? !!prev.defaultOn : !!input.defaultOn,
      createdAt: prev.createdAt || Date.now(),
      lastCheck: prev.lastCheck || null,
    };
    if (!s.name || !NAME_RE.test(s.name)) throw new Error('名前は英数字・- ・_ で 40 文字までにしてください');
    if (RESERVED.has(s.name)) throw new Error(`「${s.name}」は Claude Galaxy が使う名前です`);
    if (servers.some((x) => x.name === s.name && x.id !== s.id)) throw new Error(`同じ名前のサーバーがあります: ${s.name}`);
    if (type === 'stdio' && !s.command) throw new Error('起動コマンドを入力してください');
    if (type !== 'stdio' && !/^https?:\/\//.test(s.url)) throw new Error('URL は http:// か https:// で始めてください');
    return s;
  }

  // 画面に返すときは、env とヘッダーの値を伏せる
  const publicServer = (s) => ({
    ...s,
    env: Object.fromEntries(Object.keys(s.env).map((k) => [k, '••••'])),
    headers: Object.fromEntries(Object.keys(s.headers).map((k) => [k, '••••'])),
  });

  // --mcp-config に入れる形。ids が null なら「既定で使う」ものだけ
  function configFor(ids) {
    const pick = ids === null || ids === undefined ? servers.filter((s) => s.defaultOn) : servers.filter((s) => ids.includes(s.id));
    const out = {};
    for (const s of pick) {
      out[s.name] = s.type === 'stdio'
        ? { type: 'stdio', command: s.command, args: s.args, env: s.env }
        : { type: s.type, url: s.url, headers: s.headers };
    }
    return out;
  }

  async function check(id) {
    const s = servers.find((x) => x.id === id);
    if (!s) throw new Error('見つかりません');
    const started = Date.now();
    let r;
    try {
      r = s.type === 'stdio' ? await checkStdio(s) : s.type === 'http' ? await checkHttp(s) : { ok: false, error: 'SSE の接続確認には対応していません' };
    } catch (e) { r = { ok: false, error: e.message }; }
    s.lastCheck = { at: Date.now(), ms: Date.now() - started, ...r };
    save();
    return publicServer(s);
  }

  return {
    list: () => servers.map(publicServer),
    create(input) { const s = validate(input); servers.push(s); save(); return publicServer(s); },
    update(id, input) {
      const i = servers.findIndex((x) => x.id === id);
      if (i < 0) return null;
      const prev = servers[i];
      // 伏せ字(••••)のまま送り返された値は、元の値を残す
      const merged = { ...prev, ...input };
      if (input.env !== undefined) merged.env = keepSecret(parsePairs(input.env, '='), prev.env);
      if (input.headers !== undefined) merged.headers = keepSecret(parsePairs(input.headers, ':'), prev.headers);
      servers[i] = validate(merged, prev);
      save();
      return publicServer(servers[i]);
    },
    remove(id) {
      const i = servers.findIndex((x) => x.id === id);
      if (i < 0) return false;
      servers.splice(i, 1);
      save();
      return true;
    },
    check,
    configFor,
    ids: () => servers.map((s) => s.id),
  };
}

function keepSecret(m, old) {
  for (const [k, v] of Object.entries(m)) if (v === '••••' && old[k] !== undefined) m[k] = old[k];
  return m;
}

// ---- 接続確認: initialize → tools/list ----
const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-galaxy-check', version: '1.0' } };

function checkStdio(s) {
  return new Promise((resolve) => {
    let done = false;
    let buf = '';
    let stderr = '';
    // Windows では npx.cmd などを解決するためシェル経由で起動する
    const proc = spawn(s.command, s.args, { env: { ...process.env, ...s.env }, shell: IS_WIN, windowsHide: true });
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.kill(); } catch (_) { /* ignore */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `20 秒以内に応答がありません${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}` }), 20000);
    const send = (o) => { try { proc.stdin.write(`${JSON.stringify(o)}\n`); } catch (_) { /* ignore */ } };
    let info = null;
    proc.on('error', (e) => finish({ ok: false, error: `起動できません: ${e.message}` }));
    proc.on('exit', (code) => finish({ ok: false, error: `終了しました(code ${code})${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}` }));
    proc.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
    proc.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch (_) { continue; }
        if (m.id === 1) {
          if (m.error) return finish({ ok: false, error: m.error.message || 'initialize に失敗しました' });
          info = m.result && m.result.serverInfo;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (m.id === 2) {
          const tools = (m.result && Array.isArray(m.result.tools) ? m.result.tools : []).map((t) => t.name).slice(0, 200);
          finish({ ok: !m.error, tools, serverInfo: info, error: m.error ? m.error.message : '' });
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT });
  });
}

function postJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(data), ...headers,
      },
      timeout: 15000,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; if (text.length > 2e6) req.destroy(); });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}${res.statusCode === 401 ? '(認証が必要です)' : ''}`));
        // SSE で返ってくる場合は data: の行から取り出す
        let json = null;
        const src = /text\/event-stream/.test(res.headers['content-type'] || '')
          ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).pop() : text;
        try { json = src ? JSON.parse(src) : null; } catch (_) { /* ignore */ }
        resolve({ json, session: res.headers['mcp-session-id'] });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('応答がありません')); });
    req.end(data);
  });
}

async function checkHttp(s) {
  const init = await postJson(s.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT }, s.headers);
  if (!init.json || init.json.error) return { ok: false, error: (init.json && init.json.error && init.json.error.message) || 'initialize の応答が読めません' };
  const h = { ...s.headers, ...(init.session ? { 'Mcp-Session-Id': init.session } : {}) };
  await postJson(s.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, h).catch(() => {});
  const list = await postJson(s.url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, h);
  const tools = (list.json && list.json.result && Array.isArray(list.json.result.tools) ? list.json.result.tools : []).map((t) => t.name);
  return { ok: true, tools, serverInfo: init.json.result && init.json.result.serverInfo };
}

// ---- Claude Code 側の設定(読むだけ)----
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function describe(name, c, scope, source) {
  const type = c.type || (c.url ? 'http' : 'stdio');
  return {
    name, scope, source, type,
    target: type === 'stdio' ? [c.command, ...(c.args || [])].join(' ') : c.url,
    envKeys: Object.keys(c.env || {}),
  };
}

function claudeMcpServers(cwd) {
  const out = [];
  const home = os.homedir();
  const user = readJson(path.join(home, '.claude.json'));
  if (user && user.mcpServers) for (const [n, c] of Object.entries(user.mcpServers)) out.push(describe(n, c, 'user', '~/.claude.json'));
  if (cwd && user && user.projects) {
    const key = Object.keys(user.projects).find((p) => path.resolve(p) === path.resolve(cwd));
    const proj = key && user.projects[key];
    if (proj && proj.mcpServers) for (const [n, c] of Object.entries(proj.mcpServers)) out.push(describe(n, c, 'local', `~/.claude.json(${key})`));
  }
  if (cwd) {
    const pj = readJson(path.join(cwd, '.mcp.json'));
    if (pj && pj.mcpServers) for (const [n, c] of Object.entries(pj.mcpServers)) out.push(describe(n, c, 'project', path.join(cwd, '.mcp.json')));
  }
  return out;
}

// skills / agents / commands の一覧(フロントマターの name / description)
function frontmatter(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').slice(0, 8000); } catch (_) { return {}; }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fm = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return fm;
}

function scanDir(dir, kind, scope) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const d of names.slice(0, 500)) {
    let file = null;
    if (kind === 'skill' && d.isDirectory()) file = path.join(dir, d.name, 'SKILL.md');
    else if (kind !== 'skill' && d.isFile() && d.name.endsWith('.md')) file = path.join(dir, d.name);
    if (!file || !fs.existsSync(file)) continue;
    const fm = frontmatter(file);
    out.push({
      kind, scope, file,
      name: fm.name || d.name.replace(/\.md$/, ''),
      description: (fm.description || '').slice(0, 300),
    });
  }
  return out;
}

function claudeExtensions(cwd) {
  const home = path.join(os.homedir(), '.claude');
  const list = [];
  for (const [kind, sub] of [['skill', 'skills'], ['agent', 'agents'], ['command', 'commands']]) {
    list.push(...scanDir(path.join(home, sub), kind, 'user'));
    if (cwd) list.push(...scanDir(path.join(cwd, '.claude', sub), kind, 'project'));
  }
  return list;
}

module.exports = { createTools, claudeMcpServers, claudeExtensions };
