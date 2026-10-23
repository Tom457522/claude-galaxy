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
    this.messages = new Map(); // message.id -> { model, input, output, cacheWrite, cacheRead }
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
      this.messages.set(id, {
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

module.exports = { UsageTracker, loadPricing, priceFor, costOf, emptyTotals, PRICING_FILE };
