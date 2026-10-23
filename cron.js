'use strict';
// 5 フィールドの cron 式(分 時 日 月 曜日)。ローカル時刻で判定する。
//   * , - / が使える。曜日は 0-7(0 と 7 が日曜)。@hourly / @daily / @weekly / @monthly / @yearly も可
//   日と曜日の両方を指定したときは、どちらかに一致すれば実行(一般的な cron と同じ)

const ALIASES = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const FIELDS = [
  { name: '分', min: 0, max: 59 },
  { name: '時', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '曜日', min: 0, max: 7 },
];

function parseField(text, { name, min, max }) {
  const set = new Set();
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`cron の${name}が読めません: ${part}`);
    let lo = min;
    let hi = max;
    if (m[2] !== undefined) {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : (m[4] ? max : lo);
    }
    const step = m[4] ? Number(m[4]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`cron の${name}の範囲が不正です: ${part}`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

function parse(expr) {
  const src = String(expr || '').trim();
  const text = ALIASES[src.toLowerCase()] || src;
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new Error('cron 式は「分 時 日 月 曜日」の 5 つで指定してください(例: 0 9 * * 1-5)');
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.has(7)) dow.add(0);
  return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

function matches(c, d) {
  if (!c.minute.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.month.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

// from より後で最初に一致する時刻(なければ null)
function next(c, from = new Date()) {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 400 * 24 * 3600 * 1000;
  while (d.getTime() < limit) {
    if (!c.month.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0); continue; }
    if (matches(c, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

module.exports = { parse, matches, next };
