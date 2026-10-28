'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempHome } = require('./helpers');

const home = tempHome();
const { createCloudUsage } = require('../cloud');
const { createUsageScanner } = require('../usage');
const { createBudget } = require('../budget');

const T = (h) => new Date(2026, 9, 23, h).toISOString();
// result 行: modelUsage はプロセスが始まってからの累計
const result = (uuid, h, usd, out = 100) => ({ uuid, type: 'result', created_at: T(h),
  modelUsage: { 'claude-opus-5-5': { inputTokens: 10, outputTokens: out, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUSD: usd } } });

// 偽の Anthropic: セッション 1 件、events は 2 ページ
function fakeApi() {
  const calls = [];
  let updated = '2026-10-23T10:00:00Z';
  let extra = [];
  const pages = {
    '': { data: [{ uuid: 'e1', type: 'system' }, result('e2', 9, 4)], has_more: true, last_id: 'e2' },
    // e3: API を呼ぶ前に終わったターン(数えない・区切りにもしない)、e4: 累計 6 → このターンは 2
    e2: { data: [{ uuid: 'e3', type: 'result', created_at: T(10), modelUsage: {} }, result('e4', 10, 6, 300)], has_more: false, last_id: 'e4' },
  };
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization, org: opts.headers['x-organization-uuid'] });
    const u = new URL(url);
    let body;
    if (u.pathname === '/api/oauth/profile') body = { organization: { uuid: 'org-1' } };
    else if (u.pathname === '/v1/sessions') {
      body = { data: [{
        id: 'session_1', title: '家計アプリ', session_status: 'idle', origin: 'web_claude_ai', updated_at: updated, created_at: T(8),
        session_context: { outcomes: [{ git_info: { repo: 'me/kakei', branches: ['claude/x'] } }] },
        external_metadata: { usage: { cost_usd: 6.5, input_tokens: 1e6, output_tokens: 1e5 }, last_served_model: 'claude-opus-5-5' },
      }], has_more: false };
    } else {
      const after = u.searchParams.get('after_id') || '';
      body = pages[after] || { data: extra, has_more: false, last_id: extra.length ? extra[extra.length - 1].uuid : null };
    }
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls, touch(ev) { updated = '2026-10-23T12:00:00Z'; extra = ev; } };
}

test('クラウドセッションの応答を追記分だけ読み、ローカルと合わせて数える', async () => {
  const api = fakeApi();
  const cloud = createCloudUsage({ readCreds: () => ({ accessToken: 'tok' }), fetchImpl: api.fetchImpl });
  await cloud.refresh({ force: true });
  assert.ok(api.calls.every((c) => c.url.startsWith('https://api.anthropic.com/') && c.auth === 'Bearer tok'));
  assert.ok(api.calls.filter((c) => c.url.includes('/v1/')).every((c) => c.org === 'org-1'));
  const [s] = cloud.sessions();
  assert.deepStrictEqual([s.repo, s.branch, s.calls, s.synced, s.meta.cost], ['me/kakei', 'claude/x', 2, true, 6.5]);

  // 変わっていなければ events は読まない
  const before = api.calls.length;
  await cloud.refresh({ force: true });
  assert.strictEqual(api.calls.filter((c) => c.url.includes('/events')).length, api.calls.slice(0, before).filter((c) => c.url.includes('/events')).length);
  // 更新されたら、最後に読んだ所の続きから
  api.touch([result('e5', 11, 4)]); // 累計が減った = プロセスが作り直された → 4 をそのまま数える
  await cloud.refresh({ force: true });
  assert.ok(api.calls[api.calls.length - 1].url.includes('after_id=e4'));
  assert.strictEqual(cloud.sessions()[0].calls, 3);

  const turns = [...cloud.messages()].map((x) => [x.m.cost, x.m.output]);
  assert.deepStrictEqual(turns, [[4, 100], [2, 200], [4, 100]]);

  // ローカルのトランスクリプトと合わせる
  const dir = path.join(home, 'projects');
  fs.mkdirSync(path.join(dir, 'p'), { recursive: true });
  const row = (id, h) => JSON.stringify({ type: 'assistant', timestamp: T(h), cwd: '/w/app', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1e6, output_tokens: 0 } } });
  fs.writeFileSync(path.join(dir, 'p', 'local1.jsonl'), `${row('msg_l', 9)}\n`);
  const scan = createUsageScanner({ dir, extra: () => cloud.messages() });
  const now = new Date(2026, 9, 23, 15).getTime();
  const all = scan.report({ days: 1, now });
  // ローカル $4 + クラウド $4 + $2 + $4
  assert.ok(Math.abs(all.totals.today - 14) < 1e-9);
  assert.ok(Math.abs(all.totals.cloud - 10) < 1e-9);
  assert.ok(all.projects.some((p) => p.cwd === '☁ me/kakei' && p.cloud));
  assert.ok(Math.abs(scan.report({ days: 1, now, source: 'cloud' }).totals.today - 10) < 1e-9);
  assert.ok(Math.abs(scan.report({ days: 1, now, source: 'local' }).totals.today - 4) < 1e-9);
});

test('クラウドの使用額を 1 日の予算に数える(設定でオフにできる)', () => {
  const settings = { budgetDailyUsd: 10 };
  const b = createBudget({ getSettings: () => settings, onChange: () => {}, getCloud: () => 9 });
  b.add('jobs', 2);
  assert.strictEqual(b.status().cloud, 9);
  assert.match(b.blockReason(), /予算/);
  settings.budgetIncludeCloud = false;
  assert.strictEqual(b.blockReason(), '');
});

test('ログイン情報が無いときは読まずに知らせる', async () => {
  const cloud = createCloudUsage({ readCreds: () => null, fetchImpl: async () => { throw new Error('呼ばれない'); } });
  const st = await cloud.refresh({ force: true });
  assert.match(st.error, /ログイン情報/);
});

test('1 件のセッションの events が読めなくても、ほかのセッションは読み進める', async () => {
  const sess = (id, updated) => ({ id, title: id, updated_at: updated, created_at: T(8), session_context: {}, external_metadata: {} });
  const events = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/api/oauth/profile') return { ok: true, status: 200, json: async () => ({ organization: { uuid: 'org-1' } }) };
    if (u.pathname === '/v1/sessions') {
      return { ok: true, status: 200, json: async () => ({ data: [sess('gone', '2026-10-23T12:00:00Z'), sess('ok', '2026-10-23T11:00:00Z')], has_more: false }) };
    }
    events.push(u.pathname);
    if (u.pathname.includes('/gone/')) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: [result('k1', 9, 3)], has_more: false, last_id: 'k1' }) };
  };
  const cloud = createCloudUsage({ readCreds: () => ({ accessToken: 'tok' }), fetchImpl });
  const st = await cloud.refresh({ force: true });
  assert.match(st.error, /1 件のセッション.*gone.*404/);
  const byId = Object.fromEntries(cloud.sessions().map((s) => [s.id, s]));
  assert.deepStrictEqual([byId.ok.synced, byId.ok.calls], [true, 1]);
  assert.strictEqual(byId.gone.synced, false);
  assert.ok(events.some((p) => p.includes('/ok/')));
});
