'use strict';
// 予算: その日に使った額(概算)を数え、上限を超えたらジョブの起動を止める。保存先: ~/.claude-galaxy/spend.json
//   - ジョブ: 終わったときの total_cost_usd を足す
//   - 対話セッション: 使用量の集計が増えた分を足す(トランスクリプトから数えた概算)
//   日付はローカル時刻で区切る。90 日分だけ残す

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const FILE = path.join(DATA_DIR, 'spend.json');
const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function createBudget({ getSettings, onChange }) {
  let days = {};
  try { days = JSON.parse(fs.readFileSync(FILE, 'utf8')).days || {}; } catch (_) { days = {}; }
  let timer = null;
  let notified = { day: '', level: '' }; // 同じ日に同じ知らせを何度も出さない

  function save() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const keys = Object.keys(days).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - 90))) delete days[k];
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify({ days }, null, 2));
      } catch (e) { console.error('spend.json を保存できません:', e.message); }
    }, 1000);
    timer.unref();
  }

  function add(kind, usd) {
    if (!(usd > 0)) return;
    const d = today();
    const rec = days[d] || (days[d] = { jobs: 0, sessions: 0 });
    rec[kind] = (rec[kind] || 0) + usd;
    save();
    check();
  }

  function status() {
    const s = getSettings();
    const rec = days[today()] || { jobs: 0, sessions: 0 };
    const spent = (rec.jobs || 0) + (rec.sessions || 0);
    const limit = Number(s.budgetDailyUsd) || 0;
    return {
      day: today(),
      spent,
      jobs: rec.jobs || 0,
      sessions: rec.sessions || 0,
      limit,
      ratio: limit ? spent / limit : 0,
      over: !!limit && spent >= limit,
      warn: !!limit && spent >= limit * 0.8,
      jobDefaultUsd: Number(s.budgetJobUsd) || 0,
      sessionWarnUsd: Number(s.budgetSessionWarnUsd) || 0,
      history: Object.entries(days).sort().slice(-14).map(([day, r]) => ({ day, spent: (r.jobs || 0) + (r.sessions || 0) })),
    };
  }

  // 上限に近づいた・超えたときに 1 回だけ知らせる
  function check() {
    const st = status();
    const level = st.over ? 'over' : st.warn ? 'warn' : '';
    if (notified.day !== st.day) notified = { day: st.day, level: '' };
    if (level && level !== notified.level && (level === 'over' || notified.level === '')) {
      notified.level = level;
      onChange(st, level);
    } else {
      onChange(st, '');
    }
  }

  // ジョブを起動してよいか(だめなら理由)
  const blockReason = () => {
    const st = status();
    return st.over ? `今日の予算($${st.limit.toFixed(2)})に達したため、ジョブの起動を止めています(使用 $${st.spent.toFixed(2)})` : '';
  };

  return { add, status, blockReason, check };
}

module.exports = { createBudget };
