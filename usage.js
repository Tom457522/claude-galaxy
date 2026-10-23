'use strict';
// Claude Code のトランスクリプト(JSONL)からトークン使用量を集計し、概算コストを出す。
//   - assistant 行の message.usage を message.id ごとに保持して合計する
//     (1つの応答がコンテンツブロックごとに複数行へ分かれて書かれるため、id で重複を除く)
//   - ファイルは前回読んだ位置から追記分だけ読む
//   - 単価は既定の表 + ~/.claude-galaxy/pricing.json(あれば上書き)。あくまで概算

const fs = require('fs');
const path = require('path');
const os = require('os');

const PRICING_FILE = path.join(os.homedir(), '.claude-galaxy', 'pricing.json');

// $/100万トークン。cacheWrite / cacheRead を省略したものは input の 1.25 倍 / 0.1 倍で計算する。
// 先頭一致で、より長い接頭辞が優先される。
const DEFAULT_PRICING = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-3-7-sonnet': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
};

let pricing = null;
let pricingKeys = [];

function loadPricing() {
  let custom = {};
  try { custom = JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8')); } catch (_) { /* 無ければ既定のみ */ }
  pricing = { ...DEFAULT_PRICING };
  for (const [k, v] of Object.entries(custom || {})) {
    if (v && typeof v === 'object' && Number.isFinite(v.input) && Number.isFinite(v.output)) pricing[k] = v;
  }
  pricingKeys = Object.keys(pricing).sort((a, b) => b.length - a.length);
}

function priceFor(model) {
  if (!pricing) loadPricing();
  const m = String(model || '').toLowerCase().replace(/^(anthropic\.|us\.anthropic\.|eu\.anthropic\.)/, '');
  const key = pricingKeys.find((k) => m.startsWith(k));
  return key ? pricing[key] : null;
}

function costOf(model, u) {
  const p = priceFor(model);
  if (!p) return null;
  const cw = p.cacheWrite ?? p.input * 1.25;
  const cr = p.cacheRead ?? p.input * 0.1;
  return (u.input * p.input + u.output * p.output + u.cacheWrite * cw + u.cacheRead * cr) / 1e6;
}

const MAX_READ = 64 * 1024 * 1024; // 1回に読む上限(巨大ファイル対策)

// 1つのトランスクリプトファイルの読み取り状態
class TranscriptReader {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.rest = '';
    this.messages = new Map(); // message.id -> { model, input, output, cacheWrite, cacheRead, t }
    this.cwd = ''; // 最後に見た作業フォルダ
  }

  // 追記分を読み込む。変化があれば true
  read() {
    let st;
    try { st = fs.statSync(this.file); } catch (_) { return false; }
    if (st.size < this.offset) { this.offset = 0; this.rest = ''; this.messages.clear(); } // 作り直された
    if (st.size === this.offset) return false;
    const len = Math.min(st.size - this.offset, MAX_READ);
    const buf = Buffer.alloc(len);
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      fs.readSync(fd, buf, 0, len, this.offset);
    } catch (_) { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
    this.offset += len;
    const lines = (this.rest + buf.toString('utf8')).split('\n');
    this.rest = lines.pop();
    let changed = false;
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      let j;
      try { j = JSON.parse(line); } catch (_) { continue; }
      const msg = j && j.message;
      const u = msg && msg.usage;
      if (j.type !== 'assistant' || !u) continue;
      const id = msg.id || j.requestId || j.uuid;
      if (!id) continue;
      if (typeof j.cwd === 'string' && j.cwd) this.cwd = j.cwd;
      this.messages.set(id, {
        t: Date.parse(j.timestamp) || 0,
        model: msg.model || '',
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
      });
      changed = true;
    }
    return changed;
  }
}

const emptyTotals = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, unpriced: 0, models: {} });

// セッション1つ分(本体 + サブエージェントのトランスクリプト)の集計
class UsageTracker {
  constructor() {
    this.readers = new Map(); // file -> TranscriptReader
    this.totals = emptyTotals();
  }

  addFile(file) {
    if (typeof file !== 'string' || !file || this.readers.has(file)) return;
    if (!/\.jsonl$/i.test(file)) return;
    this.readers.set(file, new TranscriptReader(file));
  }

  // 本体トランスクリプトの隣にあるサブエージェント用ディレクトリ(<名前>/subagents/*.jsonl)も拾う
  discoverSubagents() {
    for (const file of [...this.readers.keys()]) {
      const dir = path.join(file.replace(/\.jsonl$/i, ''), 'subagents');
      let names = [];
      try { names = fs.readdirSync(dir); } catch (_) { continue; }
      for (const n of names) if (n.endsWith('.jsonl')) this.addFile(path.join(dir, n));
    }
  }

  files() { return [...this.readers.keys()]; }

  // すべて読み直して合計を更新。変化があれば true
  refresh() {
    this.discoverSubagents();
    let changed = false;
    for (const r of this.readers.values()) if (r.read()) changed = true;
    if (!changed) return false;
    const t = emptyTotals();
    const seen = new Set(); // サブエージェントの行が本体にも書かれる版があるので id で重複を除く
    for (const r of this.readers.values()) {
      for (const [id, m] of r.messages) {
        if (seen.has(id)) continue;
        seen.add(id);
        t.input += m.input; t.output += m.output; t.cacheWrite += m.cacheWrite; t.cacheRead += m.cacheRead;
        const c = costOf(m.model, m);
        if (c === null) t.unpriced += 1; else t.cost += c;
        const key = m.model || 'unknown';
        t.models[key] = (t.models[key] || 0) + m.input + m.output + m.cacheWrite + m.cacheRead;
      }
    }
    this.totals = t;
    return true;
  }
}

// ---------- Claude Code 全体の集計(Galaxy の外で使った分も含む)----------
// ~/.claude/projects/<プロジェクト>/<セッション ID>.jsonl と <セッション ID>/subagents/*.jsonl を読む

const projectsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
// グラフの色分けに使うモデルの系統
const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];
const familyOf = (model) => FAMILIES.find((f) => String(model || '').toLowerCase().includes(f)) || 'other';

function createUsageScanner({ dir = projectsDir() } = {}) {
  const readers = new Map(); // file -> { reader, session, project }

  function scan() {
    let projects = [];
    try { projects = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch (_) { return; }
    for (const p of projects) {
      const pdir = path.join(dir, p.name);
      let names = [];
      try { names = fs.readdirSync(pdir); } catch (_) { continue; }
      for (const n of names) {
        if (n.endsWith('.jsonl')) { add(path.join(pdir, n), n.slice(0, -6), p.name); continue; }
        const sub = path.join(pdir, n, 'subagents');
        let subs = [];
        try { subs = fs.readdirSync(sub); } catch (_) { continue; }
        for (const s of subs) if (s.endsWith('.jsonl')) add(path.join(sub, s), n, p.name);
      }
    }
    for (const r of readers.values()) r.reader.read();
  }

  function add(file, session, project) {
    if (!readers.has(file)) readers.set(file, { reader: new TranscriptReader(file), session, project });
  }

  // days 日分(今日を含む)を日別・モデル別・プロジェクト別・セッション別にまとめる
  function report({ days = 30, now = Date.now() } = {}) {
    days = Math.min(Math.max(Math.floor(Number(days)) || 30, 1), 365);
    scan();
    const end = new Date(now);
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - days + 1).getTime();
    const today = dayKey(now);
    const weekStart = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 6).getTime();
    const monthStart = new Date(end.getFullYear(), end.getMonth(), 1).getTime();

    const daily = new Map();
    for (let i = 0; i < days; i++) {
      const k = dayKey(new Date(end.getFullYear(), end.getMonth(), end.getDate() - days + 1 + i));
      daily.set(k, { day: k, cost: 0, tokens: 0, families: {} });
    }
    const models = new Map();
    const projects = new Map();
    const sessions = new Map();
    const sum = { today: 0, week: 0, month: 0, range: 0, tokens: 0, unpriced: 0 };
    const seen = new Set();

    // セッション本体のファイルから作業フォルダを決める(サブエージェントの分も同じフォルダに数える)
    const cwdOf = new Map();
    for (const r of readers.values()) if (r.reader.cwd && !cwdOf.has(r.session)) cwdOf.set(r.session, r.reader.cwd);

    for (const { reader, session, project } of readers.values()) {
      for (const [id, m] of reader.messages) {
        if (seen.has(id) || !m.t) continue;
        seen.add(id);
        const c = costOf(m.model, m) ?? 0;
        if (m.t >= monthStart) sum.month += c;
        if (m.t >= weekStart) sum.week += c;
        if (m.t < start) continue;
        const tok = m.input + m.output + m.cacheWrite + m.cacheRead;
        const k = dayKey(m.t);
        if (k === today) sum.today += c;
        sum.range += c; sum.tokens += tok;
        if (costOf(m.model, m) === null) sum.unpriced += 1;
        const d = daily.get(k);
        if (d) { d.cost += c; d.tokens += tok; const f = familyOf(m.model); d.families[f] = (d.families[f] || 0) + c; }
        const mk = m.model || 'unknown';
        const mo = models.get(mk) || { model: mk, family: familyOf(mk), cost: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, calls: 0 };
        mo.cost += c; mo.input += m.input; mo.output += m.output; mo.cacheWrite += m.cacheWrite; mo.cacheRead += m.cacheRead; mo.calls += 1;
        models.set(mk, mo);
        const cwd = cwdOf.get(session) || project;
        const pr = projects.get(cwd) || { cwd, cost: 0, tokens: 0, sessions: new Set() };
        pr.cost += c; pr.tokens += tok; pr.sessions.add(session);
        projects.set(cwd, pr);
        const se = sessions.get(session) || { id: session, cwd, cost: 0, tokens: 0, first: m.t, last: m.t };
        se.cost += c; se.tokens += tok; se.first = Math.min(se.first, m.t); se.last = Math.max(se.last, m.t);
        sessions.set(session, se);
      }
    }
    const byCost = (a, b) => b.cost - a.cost;
    return {
      days, today, dir, files: readers.size,
      totals: sum,
      daily: [...daily.values()],
      models: [...models.values()].sort(byCost),
      projects: [...projects.values()].map((p) => ({ ...p, sessions: p.sessions.size })).sort(byCost),
      sessions: [...sessions.values()].sort(byCost).slice(0, 20),
    };
  }

  return { scan, report };
}

module.exports = { UsageTracker, createUsageScanner, familyOf, loadPricing, priceFor, costOf, emptyTotals, PRICING_FILE };
