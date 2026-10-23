'use strict';
// エージェント間の掲示板と共有メモリ。保存先: ~/.claude-galaxy/bus.json
//   メッセージ: 宛先はエージェント ID(s1 / j3)・"user"(あなた)・"all"(全員)
//   共有メモリ: キーと値(テキスト)の組。タグと書いたエージェントを記録する

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const FILE = path.join(DATA_DIR, 'bus.json');
const MAX_MESSAGES = 1000;
const MAX_MEMORY = 2000;
const MAX_VALUE = 50000;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function createBus({ onChange }) {
  let messages = [];
  let memory = {};
  let msgSeq = 0;
  let timer = null;

  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    messages = Array.isArray(d.messages) ? d.messages : [];
    memory = d.memory && typeof d.memory === 'object' ? d.memory : {};
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
        fs.writeFileSync(tmp, JSON.stringify({ messages, memory }, null, 2));
        fs.renameSync(tmp, FILE);
      } catch (e) { console.error('bus.json を保存できません:', e.message); }
    }, 500);
    timer.unref();
  }

  const isFor = (m, id) => m.to === id || (m.to === 'all' && m.from !== id);
  const isRead = (m, id) => (m.to === 'all' ? (m.readBy || []).includes(id) : !!m.readAt);

  return {
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

    memWrite(key, value, { tags = [], author = '' } = {}) {
      const k = str(key, 200).trim();
      if (!k) throw new Error('キーが空です');
      if (!memory[k] && Object.keys(memory).length >= MAX_MEMORY) throw new Error(`共有メモリは ${MAX_MEMORY} 件までです`);
      const prev = memory[k];
      memory[k] = {
        value: str(String(value ?? ''), MAX_VALUE),
        tags: (Array.isArray(tags) ? tags : []).map((t) => str(String(t), 40).trim()).filter(Boolean).slice(0, 20),
        author,
        createdAt: prev ? prev.createdAt : Date.now(),
        updatedAt: Date.now(),
      };
      save();
      return { key: k, ...memory[k] };
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
  };
}

module.exports = { createBus };
