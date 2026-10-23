'use strict';
// プランの実際の利用率(5 時間・週間の制限)を読み、グラフ用に記録し、上限に近づいたらジョブの起動を止める。
//   - Claude Code のログイン情報(~/.claude/.credentials.json、macOS はキーチェーン)のアクセストークンで
//     api.anthropic.com の /api/oauth/usage と /api/oauth/profile を読む。トークンはそこ以外へは送らない
//   - トークンの更新はしない(Claude Code が動くたびに更新する)。期限切れなら読めないと知らせるだけ
//   - 5 分ごとに読み、利用率を ~/.claude-galaxy/plan-usage.json に 30 日分残す

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DATA_DIR } = require('./store');

const FILE = path.join(DATA_DIR, 'plan-usage.json');
const API = 'https://api.anthropic.com/api/oauth';
const POLL_MS = 5 * 60 * 1000;
const PROFILE_MS = 6 * 60 * 60 * 1000;
const MIN_REFRESH_MS = 30 * 1000; // 画面から「読み直す」を連打されても API を叩きすぎない
const STALE_MS = 15 * 60 * 1000; // これより古い値ではジョブを止めない
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const WINDOW_MS = { session: 5 * HOUR, weekly: 7 * 24 * HOUR };

const LABELS = {
  session: '5 時間',
  weekly_all: '週間(全モデル)',
  weekly_opus: '週間(Opus)',
  weekly_sonnet: '週間(Sonnet)',
  weekly_oauth_apps: '週間(外部アプリ)',
  weekly_cowork: '週間(Cowork)',
};

// 月額(USD)。年払いや円建ての人は設定の planMonthlyUsd で上書きする
function planOf(type, tier) {
  type = String(type || '').toLowerCase();
  tier = String(tier || '').toLowerCase();
  if (type === 'max') return /20x/.test(tier) ? { name: 'Max 20x', monthlyUsd: 200 } : { name: 'Max 5x', monthlyUsd: 100 };
  if (type === 'pro') return { name: 'Pro', monthlyUsd: 20 };
  if (type === 'team') return { name: 'Team', monthlyUsd: null };
  if (type === 'enterprise') return { name: 'Enterprise', monthlyUsd: null };
  return { name: type || '不明', monthlyUsd: null };
}

const credFile = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');

function readCredentials(file = credFile()) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) {
    if (process.platform === 'darwin') {
      try { raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', timeout: 5000 }); } catch (_) { /* 無い */ }
    }
  }
  try {
    const o = JSON.parse(raw).claudeAiOauth;
    return o && o.accessToken ? o : null;
  } catch (_) { return null; }
}

// /api/oauth/usage の応答を画面で使う形にする
function parseUsage(j, now = Date.now()) {
  const list = Array.isArray(j.limits) && j.limits.length ? j.limits : [
    j.five_hour && { kind: 'session', group: 'session', percent: j.five_hour.utilization, resets_at: j.five_hour.resets_at },
    j.seven_day && { kind: 'weekly_all', group: 'weekly', percent: j.seven_day.utilization, resets_at: j.seven_day.resets_at },
  ].filter(Boolean);
  const limits = list.filter((l) => l && Number.isFinite(Number(l.percent))).map((l) => {
    const group = l.group || (String(l.kind).startsWith('weekly') ? 'weekly' : 'session');
    const resetsAt = Date.parse(l.resets_at) || 0;
    const windowMs = WINDOW_MS[group] || 0;
    const startsAt = resetsAt && windowMs ? resetsAt - windowMs : 0;
    const elapsed = startsAt ? Math.min(1, Math.max(0, (now - startsAt) / windowMs)) : null;
    const percent = Number(l.percent);
    return {
      kind: String(l.kind || group),
      group,
      label: LABELS[l.kind] || String(l.kind || group),
      percent,
      severity: l.severity || '',
      resetsAt,
      startsAt,
      windowMs,
      elapsed,
      // このままのペースで使い続けたときのリセット時点の見込み(経過 5% 未満は当てにならないので出さない)
      projected: elapsed && elapsed >= 0.05 ? percent / elapsed : null,
    };
  });
  const ex = j.extra_usage;
  const extra = ex && ex.is_enabled ? {
    usedUsd: Number(ex.used_credits) || 0,
    limitUsd: Number(ex.monthly_limit) || 0,
    percent: Number(ex.utilization) || 0,
  } : null;
  const bd = j.seven_day_breakdown;
  const breakdown = bd && Array.isArray(bd.rows) ? bd.rows.map((r) => ({ key: r.key, name: r.display_name || r.key, percent: Number(r.percent) || 0 })) : [];
  return { limits, extra, breakdown };
}

function createPlanMonitor({ getSettings, onChange = () => {}, fetchImpl = (...a) => fetch(...a), readCreds = readCredentials, now = () => Date.now() }) {
  let history = [];
  try { history = JSON.parse(fs.readFileSync(FILE, 'utf8')).history || []; } catch (_) { history = []; }
  let usage = null; // parseUsage の結果
  let fetchedAt = 0;
  let profile = null;
  let profileAt = 0;
  let error = '';
  let inflight = null;
  let lastTry = 0;
  let saveTimer = null;
  const notified = new Map(); // `${kind}@${resetsAt}` -> 'warn' | 'over'

  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const cut = now() - KEEP_MS;
      history = history.filter((h) => h.t >= cut);
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify({ history }));
      } catch (e) { console.error('plan-usage.json を保存できません:', e.message); }
    }, 1000);
    saveTimer.unref();
  }

  // 値が変わったとき、または 30 分ぶりのときだけ残す
  function record(t, limits) {
    const v = Object.fromEntries(limits.map((l) => [l.kind, l.percent]));
    const last = history[history.length - 1];
    if (last && t - last.t < 30 * 60 * 1000 && JSON.stringify(last.v) === JSON.stringify(v)) return;
    history.push({ t, v });
    save();
  }

  async function get(url, token) {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) throw new Error('ログイン情報の期限が切れています。Claude Code を一度使うと更新されます');
    if (!res.ok) throw new Error(`Anthropic の応答が HTTP ${res.status} でした`);
    return res.json();
  }

  async function refresh({ force = false } = {}) {
    if (inflight) return inflight;
    if (!force && now() - lastTry < MIN_REFRESH_MS) return status();
    lastTry = now();
    inflight = (async () => {
      const cred = readCreds();
      if (!cred) {
        error = 'Claude Code のログイン情報が見つかりません(claude でログインすると読めるようになります)';
        return;
      }
      if (!profile) profile = { type: cred.subscriptionType, tier: cred.rateLimitTier };
      try {
        const j = await get(`${API}/usage`, cred.accessToken);
        const t = now();
        usage = parseUsage(j, t);
        fetchedAt = t;
        error = '';
        record(t, usage.limits);
        if (t - profileAt > PROFILE_MS) {
          profileAt = t;
          try {
            const p = await get(`${API}/profile`, cred.accessToken);
            const org = (p && p.organization) || {};
            profile = {
              type: cred.subscriptionType || String(org.organization_type || '').replace(/^claude_/, ''),
              tier: org.rate_limit_tier || cred.rateLimitTier,
              billing: org.billing_type || '',
              subscription: org.subscription_status || '',
            };
          } catch (_) { /* プラン名は資格情報のもので足りる */ }
        }
      } catch (e) {
        error = e.name === 'TimeoutError' ? 'Anthropic に接続できませんでした(タイムアウト)' : e.message;
      }
    })().finally(() => { inflight = null; });
    await inflight;
    check();
    return status();
  }

  // 各制限の「ジョブを止める利用率」。設定が 0 なら 100%(実際の上限)で止める
  function thresholdOf(group) {
    const s = getSettings();
    const v = Number(group === 'session' ? s.planLimitSessionPct : s.planLimitWeeklyPct) || 0;
    return v > 0 && v < 100 ? v : 100;
  }

  function evaluate(l) {
    const s = getSettings();
    const threshold = thresholdOf(l.group);
    let reason = '';
    if (l.percent >= threshold) {
      reason = `${l.label}の利用率 ${Math.round(l.percent)}% が上限 ${threshold}% に達しています`;
    } else if (s.planPaceGuard && l.group === 'weekly' && l.elapsed !== null) {
      const margin = Number(s.planPaceMargin) || 10;
      const pace = l.elapsed * 100;
      if (l.percent > pace + margin) reason = `${l.label}の利用率 ${Math.round(l.percent)}% が経過時間 ${Math.round(pace)}% より ${margin} ポイント以上先に進んでいます`;
    }
    return { threshold, reason };
  }

  function status() {
    const p = profile ? planOf(profile.type, profile.tier) : null;
    const override = Number(getSettings().planMonthlyUsd) || 0;
    const t = now();
    const limits = usage ? usage.limits.map((l) => {
      const elapsed = l.startsAt ? Math.min(1, Math.max(0, (t - l.startsAt) / l.windowMs)) : null;
      const x = { ...l, elapsed };
      return { ...x, ...evaluate(x) };
    }) : [];
    return {
      ok: !!usage,
      error,
      fetchedAt,
      stale: !fetchedAt || t - fetchedAt > STALE_MS,
      plan: p && { ...profile, name: p.name, monthlyUsd: override || p.monthlyUsd, monthlyAuto: !override },
      limits,
      extra: usage ? usage.extra : null,
      breakdown: usage ? usage.breakdown : [],
      history,
      paceGuard: !!getSettings().planPaceGuard,
    };
  }

  // ジョブを起動してよいか(だめなら理由)。古い値や読めないときは止めない
  function blockReason() {
    const st = status();
    if (!st.ok || st.stale) return '';
    const hit = st.limits.find((l) => l.reason && (!l.resetsAt || l.resetsAt > now()));
    if (!hit) return '';
    const at = hit.resetsAt ? new Date(hit.resetsAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    return `${hit.reason}。ジョブの起動を止めています${at ? `(${at} にリセット)` : ''}`;
  }

  // しきい値の 10 ポイント手前で warn、到達で over を、リセットの区切りごとに 1 回だけ知らせる
  function check() {
    const st = status();
    let level = '';
    let hit = null;
    for (const l of st.limits) {
      const key = `${l.kind}@${l.resetsAt}`;
      const lv = l.reason ? 'over' : l.percent >= l.threshold - 10 ? 'warn' : '';
      const prev = notified.get(key) || '';
      if (lv && lv !== prev && (lv === 'over' || !prev)) {
        notified.set(key, lv);
        if (!level || lv === 'over') { level = lv; hit = l; }
      }
    }
    for (const k of notified.keys()) if (!st.limits.some((l) => `${l.kind}@${l.resetsAt}` === k)) notified.delete(k);
    onChange(st, level, hit);
  }

  let timer = null;
  function start() {
    refresh({ force: true });
    timer = setInterval(() => refresh({ force: true }), POLL_MS);
    timer.unref();
  }
  function stop() { clearInterval(timer); timer = null; }

  return { refresh, status, blockReason, check, start, stop };
}

module.exports = { createPlanMonitor, parseUsage, planOf, readCredentials };
