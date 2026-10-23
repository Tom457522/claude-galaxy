'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tempHome } = require('./helpers');

tempHome();
const { createPlanMonitor, parseUsage, planOf } = require('../plan');

const HOUR = 3600e3;
const NOW = Date.parse('2026-10-23T15:00:00Z');
const usageBody = (session, weekly) => ({
  five_hour: { utilization: session, resets_at: new Date(NOW + 2 * HOUR).toISOString() },
  seven_day: { utilization: weekly, resets_at: new Date(NOW + 3.5 * 24 * HOUR).toISOString() },
  extra_usage: { is_enabled: false },
  seven_day_breakdown: { rows: [{ key: 'claude_code', display_name: 'Claude Code', percent: 87 }] },
});

function monitor(settings, body) {
  const calls = [];
  const levels = [];
  const m = createPlanMonitor({
    getSettings: () => settings,
    onChange: (_st, level, hit) => { if (level) levels.push(`${level}:${hit.kind}`); },
    readCreds: () => ({ accessToken: 'tok', subscriptionType: 'pro', rateLimitTier: 'default_claude_ai' }),
    fetchImpl: async (url, opts) => {
      calls.push({ url, auth: opts.headers.Authorization });
      return { ok: true, status: 200, json: async () => (url.endsWith('/usage') ? body() : { organization: { organization_type: 'claude_pro' } }) };
    },
    now: () => NOW,
  });
  return { m, calls, levels };
}

test('プランと月額を見分ける', () => {
  assert.deepStrictEqual(planOf('pro', 'default_claude_ai'), { name: 'Pro', monthlyUsd: 20 });
  assert.strictEqual(planOf('max', 'default_claude_max_20x').monthlyUsd, 200);
  assert.strictEqual(planOf('max', 'default_claude_max_5x').monthlyUsd, 100);
  assert.strictEqual(planOf('team', '').monthlyUsd, null);
});

test('利用率・期間・このペースでの見込みを出す', () => {
  const { limits, breakdown, extra } = parseUsage(usageBody(30, 50), NOW);
  const s = limits.find((l) => l.kind === 'session');
  assert.strictEqual(s.windowMs, 5 * HOUR);
  assert.ok(Math.abs(s.elapsed - 0.6) < 1e-9); // 5 時間のうち 3 時間経過
  assert.ok(Math.abs(s.projected - 50) < 1e-9);
  const w = limits.find((l) => l.kind === 'weekly_all');
  assert.ok(Math.abs(w.elapsed - 0.5) < 1e-9);
  assert.strictEqual(breakdown[0].percent, 87);
  assert.strictEqual(extra, null);
});

test('しきい値に達したらジョブを止め、1 回だけ知らせる。トークンは Anthropic にだけ送る', async () => {
  const settings = { planLimitSessionPct: 0, planLimitWeeklyPct: 60 };
  let cur = [30, 55];
  const { m, calls, levels } = monitor(settings, () => usageBody(...cur));
  await m.refresh({ force: true });
  assert.ok(calls.every((c) => c.url.startsWith('https://api.anthropic.com/') && c.auth === 'Bearer tok'));
  assert.strictEqual(m.status().plan.name, 'Pro');
  assert.strictEqual(m.status().plan.monthlyUsd, 20);
  assert.strictEqual(m.blockReason(), '');
  assert.deepStrictEqual(levels, ['warn:weekly_all']); // 60% の 10 ポイント手前
  cur = [30, 61];
  await m.refresh({ force: true });
  assert.match(m.blockReason(), /週間.*60%/);
  await m.refresh({ force: true });
  assert.deepStrictEqual(levels, ['warn:weekly_all', 'over:weekly_all']);
  settings.planLimitWeeklyPct = 0; // 0 は 100%(実際の上限)
  assert.strictEqual(m.blockReason(), '');
  cur = [100, 61];
  await m.refresh({ force: true });
  assert.match(m.blockReason(), /5 時間.*100%/);
  assert.strictEqual(m.status().history.length, 3); // 同じ値の連続は記録しない
});

test('週のペースガード', async () => {
  const settings = { planPaceGuard: true, planPaceMargin: 10 };
  let cur = [10, 59]; // 経過 50% に対して 59%
  const { m } = monitor(settings, () => usageBody(...cur));
  await m.refresh({ force: true });
  assert.strictEqual(m.blockReason(), '');
  cur = [10, 61];
  await m.refresh({ force: true });
  assert.match(m.blockReason(), /経過時間 50%/);
});

test('ログイン情報が無い・読めないときは止めない', async () => {
  const m = createPlanMonitor({ getSettings: () => ({}), readCreds: () => null, fetchImpl: async () => { throw new Error('呼ばれない'); } });
  const st = await m.refresh({ force: true });
  assert.ok(!st.ok);
  assert.match(st.error, /ログイン情報/);
  assert.strictEqual(m.blockReason(), '');
  const m2 = createPlanMonitor({
    getSettings: () => ({}),
    readCreds: () => ({ accessToken: 'x' }),
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  assert.match((await m2.refresh({ force: true })).error, /期限/);
});
