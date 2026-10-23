'use strict';
// 全文検索: セッションの画面出力・ジョブの経過と結果・メッセージ・共有メモリを横断して探す

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const LOG_DIR = path.join(DATA_DIR, 'logs');
const MAX_READ = 2 * 1024 * 1024;
// 画面出力から、色や カーソル移動などの制御文字を取り除く
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>78]/g;
const strip = (t) => t.replace(ANSI, '').replace(/\r(?!\n)/g, '\n').replace(/[\x00-\x08\x0b-\x1f]/g, '');

function tail(file) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, MAX_READ);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    return buf.toString('utf8');
  } catch (_) { return ''; }
}

function snippet(text, idx, len) {
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + len + 100);
  return `${start ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

// text の中から、すべての語を含む「行」を探す(最大 per 件)
function findLines(text, words, per) {
  const out = [];
  for (const line of text.split('\n')) {
    const low = line.toLowerCase();
    if (words.every((w) => low.includes(w))) {
      out.push(snippet(line, low.indexOf(words[0]), words[0].length));
      if (out.length >= per) break;
    }
  }
  return out;
}

// deps: sessions() -> [{id,name}], jobs() -> [{id,name,prompt,result,error}], transcript(id), messages(), memory()
function search(q, deps, { limit = 200, per = 5 } = {}) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = [];
  const push = (h) => { if (hits.length < limit) hits.push(h); };

  for (const s of deps.sessions()) {
    for (const sn of findLines(strip(tail(path.join(LOG_DIR, `${s.id}.log`))), words, per)) push({ kind: 'session', id: s.id, name: s.name, snippet: sn });
  }
  for (const j of deps.jobs()) {
    const text = [j.name, j.prompt, ...deps.transcript(j.id).map((e) => e.text), j.result, j.error].filter(Boolean).join('\n');
    for (const sn of findLines(text, words, per)) push({ kind: 'job', id: j.id, name: j.name, snippet: sn, at: j.endedAt || j.createdAt });
  }
  for (const m of deps.messages()) {
    const text = `${m.fromName || m.from} → ${m.toName || m.to}: ${m.text}`;
    const low = text.toLowerCase();
    if (words.every((w) => low.includes(w))) push({ kind: 'message', id: m.id, name: `${m.fromName || m.from} → ${m.toName || m.to}`, snippet: snippet(text, low.indexOf(words[0]), words[0].length), at: m.at });
  }
  for (const m of deps.memory()) {
    const text = `${m.key}\n${m.value}\n${(m.tags || []).join(' ')}`;
    const low = text.toLowerCase();
    if (words.every((w) => low.includes(w))) push({ kind: 'memory', id: m.key, name: m.key, snippet: snippet(text, low.indexOf(words[0]), words[0].length), at: m.updatedAt });
  }
  return hits;
}

module.exports = { search, strip };
