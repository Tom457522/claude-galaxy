'use strict';
// 監査ログ: エージェントが何をしたか(ツールの実行・権限の判断・起動と終了など)を日ごとの JSONL に残す。
//   保存先: ~/.claude-galaxy/audit/YYYY-MM-DD.jsonl(既定 30 日で消す)
//   ファイルの中身は残さない。対象(ファイルパス・コマンドの先頭など)だけを記録する

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const DIR = path.join(DATA_DIR, 'audit');
const MAX_READ = 20 * 1024 * 1024;

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);

// ツール入力から「何に対して」を短く取り出す
function targetOf(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.command || input.file_path || input.notebook_path || input.url || input.pattern || input.path ||
    input.description || input.prompt || '';
  return clip(String(v), 300) || '';
}

function createAudit({ getSettings }) {
  let stream = null;
  let streamDay = '';
  const listeners = new Set();

  function out(day) {
    if (stream && streamDay === day) return stream;
    if (stream) stream.end();
    fs.mkdirSync(DIR, { recursive: true });
    stream = fs.createWriteStream(path.join(DIR, `${day}.jsonl`), { flags: 'a' });
    stream.on('error', () => { /* 書けなくても本体は止めない */ });
    streamDay = day;
    return stream;
  }

  // kind: tool / permission / session-start / session-exit / job-start / job-end / automation / message / dispatch
  function log(entry) {
    if (!getSettings().auditEnabled) return;
    const e = {
      t: Date.now(),
      agent: entry.agent || '',
      agentName: clip(entry.agentName, 100) || '',
      kind: entry.kind,
      tool: clip(entry.tool, 100),
      target: clip(entry.target, 300),
      detail: clip(entry.detail, 500),
      cwd: clip(entry.cwd, 500),
    };
    for (const k of Object.keys(e)) if (e[k] === undefined || e[k] === '') delete e[k];
    out(dayOf(e.t)).write(`${JSON.stringify(e)}\n`);
    for (const fn of listeners) fn(e);
  }

  // 新しい順に返す。days: さかのぼる日数
  function query({ days = 2, agent = '', kind = '', q = '', limit = 1000 } = {}) {
    const list = [];
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    for (let i = 0; i < Math.min(31, Math.max(1, days)) && list.length < limit; i++) {
      const file = path.join(DIR, `${dayOf(Date.now() - i * 86400000)}.jsonl`);
      let text = '';
      try {
        const st = fs.statSync(file);
        const len = Math.min(st.size, MAX_READ);
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(file, 'r');
        try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
        text = buf.toString('utf8');
      } catch (_) { continue; }
      const lines = text.split('\n');
      for (let j = lines.length - 1; j >= 0 && list.length < limit; j--) {
        if (!lines[j]) continue;
        let e;
        try { e = JSON.parse(lines[j]); } catch (_) { continue; }
        if (agent && e.agent !== agent) continue;
        if (kind && e.kind !== kind) continue;
        if (words.length) {
          const hay = `${e.agent} ${e.agentName} ${e.kind} ${e.tool || ''} ${e.target || ''} ${e.detail || ''} ${e.cwd || ''}`.toLowerCase();
          if (!words.every((w) => hay.includes(w))) continue;
        }
        list.push(e);
      }
    }
    return list;
  }

  // 保存期間を過ぎたファイルを消す
  function prune() {
    const keep = Math.max(1, Number(getSettings().auditDays) || 30);
    const limit = dayOf(Date.now() - keep * 86400000);
    let names = [];
    try { names = fs.readdirSync(DIR); } catch (_) { return; }
    for (const n of names) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(n);
      if (m && m[1] < limit) { try { fs.unlinkSync(path.join(DIR, n)); } catch (_) { /* ignore */ } }
    }
  }
  prune();
  setInterval(prune, 6 * 3600 * 1000).unref();

  return {
    log,
    query,
    onEntry: (fn) => listeners.add(fn),
    close: () => { if (stream) stream.end(); },
  };
}

module.exports = { createAudit, targetOf };
