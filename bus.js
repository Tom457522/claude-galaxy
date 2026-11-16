'use strict';
// エージェント間の掲示板と共有メモリ。保存先: ~/.claude-galaxy/bus.json
//   メッセージ: 宛先はエージェント ID(s1 / j3)・"user"(あなた)・"all"(全員)
//   共有メモリ: キーと値(テキスト)の組。タグと書いたエージェントを記録する
//     priority: 'must'(必須)/ 'normal'(参考)、expires: 有効期限 YYYY-MM-DD、verified: 人が確認したか
//     エージェントが書くと verified は外れ、重要度と期限は変えられない(人だけが決める)
//   候補: エージェントが memory_propose で出した「書き換え・削除」の提案。人が承認すると共有メモリに入る

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const FILE = path.join(DATA_DIR, 'bus.json');
const MAX_MESSAGES = 1000;
const MAX_MEMORY = 2000;
const MAX_VALUE = 50000;
const MAX_CANDIDATES = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
// キー・タグは 1 行にする(改行で見出しを作り、最初に渡す内容の「必須・確認済み」の目印を偽装できないように)
const line = (v, max) => str(v, max).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
const MAX_CANDIDATES_PER_AUTHOR = 30;

function createBus({ onChange }) {
  let messages = [];
  let memory = {};
  let candidates = [];
  let msgSeq = 0;
  let candSeq = 0;
  let timer = null;

  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    messages = Array.isArray(d.messages) ? d.messages : [];
    memory = d.memory && typeof d.memory === 'object' ? d.memory : {};
    candidates = Array.isArray(d.candidates) ? d.candidates : [];
    candSeq = candidates.reduce((n, c) => Math.max(n, Number(String(c.id).slice(1)) || 0), 0);
    msgSeq = messages.reduce((n, m) => Math.max(n, Number(String(m.id).slice(1)) || 0), 0);
  } catch (_) { /* 初回 */ }

  function save() {
    onChange();
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = `${FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ messages, memory, candidates }, null, 2));
        fs.renameSync(tmp, FILE);
      } catch (e) { console.error('bus.json を保存できません:', e.message); }
    }, 500);
    timer.unref();
  }

  const isFor = (m, id) => m.to === id || (m.to === 'all' && m.from !== id);
  const isRead = (m, id) => (m.to === 'all' ? (m.readBy || []).includes(id) : !!m.readAt);

  const api = {
    send({ from, fromName, to, toName, text, replyTo }) {
      const body = str(text, 20000).trim();
      if (!body) throw new Error('本文が空です');
      const m = {
        id: `m${++msgSeq}`, from, fromName, to, toName, text: body, at: Date.now(),
        readAt: null, readBy: [], replyTo: replyTo || null,
      };
      messages.push(m);
      if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
      save();
      return m;
    },

    // id 宛て(と全員宛て)のメッセージ。markRead なら既読にする
    inbox(id, { unreadOnly = true, markRead = true, limit = 50 } = {}) {
      const list = messages.filter((m) => isFor(m, id) && (!unreadOnly || !isRead(m, id))).slice(-limit);
      if (markRead && list.length) {
        const now = Date.now();
        for (const m of list) {
          if (m.to === 'all') { if (!m.readBy.includes(id)) m.readBy.push(id); } else if (!m.readAt) m.readAt = now;
        }
        save();
      }
      return list;
    },

    unreadCount: (id) => messages.filter((m) => isFor(m, id) && !isRead(m, id)).length,
    messages: (limit = 300) => messages.slice(-limit),

    clearMessages() { messages = []; save(); },

    // source: 書いたエージェント({ kind: 'session' | 'job', id })。要約の元になった記録(ジョブの transcript・
    //   セッションの画面ログ)を後から search で引けるように残す。古いデータにはない
    // meta: { priority, expires, verified }(人が書くときだけ。省いた項目は前の値を残す)
    // agent: エージェントが書いた(verified を外し、重要度と期限は前の値のまま)
    memWrite(key, value, { tags = [], author = '', source = null, meta = {}, agent = false } = {}) {
      const k = line(key, 200);
      if (!k) throw new Error('キーが空です');
      if (!memory[k] && Object.keys(memory).length >= MAX_MEMORY) throw new Error(`共有メモリは ${MAX_MEMORY} 件までです`);
      const prev = memory[k];
      // 必須・確認済みの項目は、エージェントが直接書き換えられない(memory_propose で候補を出し、人が承認する)
      if (agent && prev && (prev.priority === 'must' || prev.verified)) {
        throw new Error(`「${k}」は${prev.priority === 'must' ? '必須' : '確認済み'}の項目なので直接は書き換えられません。memory_propose で候補を出してください`);
      }
      const m = agent ? {} : (meta || {});
      if (m.priority !== undefined && m.priority !== 'must' && m.priority !== 'normal') throw new Error('重要度は must か normal です');
      if (m.expires !== undefined && m.expires !== '' && !(typeof m.expires === 'string' && DATE_RE.test(m.expires))) throw new Error('有効期限は YYYY-MM-DD で指定してください');
      memory[k] = {
        value: str(String(value ?? ''), MAX_VALUE),
        tags: (Array.isArray(tags) ? tags : []).map((t) => line(String(t), 40)).filter(Boolean).slice(0, 20),
        author,
        ...(source && (source.kind === 'session' || source.kind === 'job') && typeof source.id === 'string'
          ? { source: { kind: source.kind, id: str(source.id, 40) } } : {}),
        priority: m.priority ?? prev?.priority ?? 'normal',
        expires: m.expires ?? prev?.expires ?? '',
        verified: agent ? false : (m.verified !== undefined ? !!m.verified : !!prev?.verified),
        createdAt: prev ? prev.createdAt : Date.now(),
        updatedAt: Date.now(),
      };
      save();
      return { key: k, ...memory[k] };
    },

    // 確認済みの印だけを付け外しする(本文は変えない)
    memVerify(key, verified = true) {
      if (!memory[key]) return null;
      memory[key].verified = !!verified;
      save();
      return { key, ...memory[key] };
    },

    memRead: (key) => (memory[key] ? { key, ...memory[key] } : null),

    memDelete(key) {
      if (!memory[key]) return false;
      delete memory[key];
      save();
      return true;
    },

    // キー・値・タグの部分一致(空白区切りの語をすべて含むもの)。更新が新しい順
    memSearch(query, { prefix = '', limit = 50 } = {}) {
      const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
      return Object.entries(memory)
        .filter(([k]) => !prefix || k.startsWith(prefix))
        .filter(([k, v]) => {
          const hay = `${k}\n${v.value}\n${v.tags.join(' ')}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        })
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, limit)
        .map(([k, v]) => ({ key: k, ...v }));
    },

    // ---- 候補(エージェントの提案。人が承認するまで共有メモリは変わらない)----
    propose({ action, key, value, tags, reason, author = '', source = null }) {
      const act = action === 'delete' ? 'delete' : 'write';
      const k = line(key, 200);
      if (!k) throw new Error('キーが空です');
      if (act === 'delete' && !memory[k]) throw new Error(`そのキーはありません: ${k}`);
      const v = act === 'write' ? str(String(value ?? ''), MAX_VALUE) : '';
      if (act === 'write' && !v.trim()) throw new Error('本文が空です');
      const same = candidates.find((c) => c.action === act && c.key === k && c.value === v);
      if (same) return same;
      if (candidates.length >= MAX_CANDIDATES) throw new Error(`候補は ${MAX_CANDIDATES} 件までです。人が承認・却下するのを待ってください`);
      if (author && candidates.filter((c) => c.author === author).length >= MAX_CANDIDATES_PER_AUTHOR) {
        throw new Error(`1 つのエージェントが出せる候補は ${MAX_CANDIDATES_PER_AUTHOR} 件までです。人が承認・却下するのを待ってください`);
      }
      const c = {
        id: `c${++candSeq}`, action: act, key: k, value: v,
        tags: Array.isArray(tags) ? tags.map((t) => line(String(t), 40)).filter(Boolean).slice(0, 20) : null,
        reason: str(String(reason ?? ''), 2000).trim(),
        author,
        ...(source && (source.kind === 'session' || source.kind === 'job') && typeof source.id === 'string'
          ? { source: { kind: source.kind, id: str(source.id, 40) } } : {}),
        at: Date.now(),
      };
      candidates.push(c);
      save();
      return c;
    },

    candidates: () => candidates.map((c) => ({ ...c, current: memory[c.key] ? memory[c.key].value : null })),

    // 承認: 書き換えなら確認済みとして書く(重要度・期限は前の値のまま)。value を渡すと直してから入れる
    approveCandidate(id, { value, author = 'あなた' } = {}) {
      const i = candidates.findIndex((c) => c.id === id);
      if (i < 0) throw new Error('候補が見つかりません');
      const c = candidates[i];
      let out;
      if (c.action === 'delete') out = { deleted: api.memDelete(c.key), key: c.key };
      else {
        const prev = memory[c.key];
        out = api.memWrite(c.key, typeof value === 'string' ? value : c.value, {
          tags: c.tags || (prev ? prev.tags : []),
          author: `${author}(候補 ${c.id} を承認。提案: ${c.author || '不明'})`,
          source: c.source,
          meta: { verified: true },
        });
      }
      candidates.splice(candidates.findIndex((x) => x.id === id), 1);
      save();
      return out;
    },

    rejectCandidate(id) {
      const i = candidates.findIndex((c) => c.id === id);
      if (i < 0) return false;
      candidates.splice(i, 1);
      save();
      return true;
    },
  };
  return api;
}

module.exports = { createBus };
