'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rec = require('../recommend');

const NOW = Date.parse('2026-11-16T12:00:00Z');
const BASE = {
  permissionInbox: true, busEnabled: true, memoryLearn: false, memoryExportVault: '', memoryExportMode: 'off', maxConcurrentJobs: 2,
  auditEnabled: true, auditDays: 30, budgetDailyUsd: 0, budgetJobUsd: 0, budgetSessionWarnUsd: 0, budgetIncludeCloud: true,
  planLimitSessionPct: 0, planLimitWeeklyPct: 0, planPaceGuard: false, planPaceMargin: 10, notifyDesktop: true, approvalGate: false, collectSafetyEvents: false,
};
const usage = (costs, sessions = []) => ({ daily: costs.map((cost, i) => ({ day: `d${i}`, cost })), sessions: sessions.map((cost) => ({ cost })), totals: { cloud: 0 } });
const plan = (type, name, weekly = 10, hist = []) => ({ ok: true, plan: { type, name }, limits: [{ group: 'session', percent: 5 }, { group: 'weekly', percent: weekly }], history: hist });
const ids = (items) => items.map((i) => i.id);

test('値を型と範囲に合わせる', () => {
  assert.strictEqual(rec.sanitize('budgetDailyUsd', '12.345'), 12.35);
  assert.strictEqual(rec.sanitize('budgetDailyUsd', -3), 0);
  assert.strictEqual(rec.sanitize('planLimitWeeklyPct', 180), 100);
  assert.strictEqual(rec.sanitize('maxConcurrentJobs', 0), 1);
  assert.strictEqual(rec.sanitize('auditDays', 60), 30);
  assert.strictEqual(rec.sanitize('approvalGate', 'true'), undefined);
  assert.strictEqual(rec.sanitize('budgetDailyUsd', true), undefined);
  assert.strictEqual(rec.sanitize('memoryExportMode', 'rm'), undefined);
  assert.strictEqual(rec.sanitize('busEnabled', false), undefined); // 対象外のキー
  assert.strictEqual(rec.sanitize('constructor', 1), undefined); // 継承プロパティは通さない
  assert.strictEqual(rec.sanitize('toString', true), undefined);
});

test('切りのよい値への切り上げと分位点', () => {
  assert.strictEqual(rec.niceUp(3.2), 4);
  assert.strictEqual(rec.niceUp(12), 15);
  assert.strictEqual(rec.niceUp(73), 80);
  assert.strictEqual(rec.niceUp(0), 0);
  assert.strictEqual(rec.quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.strictEqual(rec.quantile([], 0.9), 0);
});

test('使い始めで材料がなければ、案を出さない', () => {
  const f = rec.facts({ settings: BASE, usage: usage([0, 0, 0]), now: NOW });
  assert.deepStrictEqual(rec.recommend(f, BASE), []);
});

test('API 利用で毎日使っているなら、1 日の上限を p90 の 1.5 倍で高い優先度にする', () => {
  const f = rec.facts({ settings: BASE, usage: usage([2, 3, 4, 5, 6, 0, 8, 10]), now: NOW });
  const it = rec.recommend(f, BASE).find((i) => i.id === 'budget-daily');
  assert.ok(it);
  assert.strictEqual(it.priority, 'high');
  assert.strictEqual(it.patch.budgetDailyUsd, 15); // p90 = 10 → 15
  assert.strictEqual(it.changes[0].fromText, '上限なし');
  assert.strictEqual(it.changes[0].toText, '$15');
});

test('定額プランで無人のオートメーションがあれば、承認ゲートと週の枠を高い優先度で勧める', () => {
  const autos = [{ enabled: true, template: { permissionMode: 'acceptEdits' } }, { enabled: false, template: {} }];
  const jobs = [{ createdAt: NOW - 1000, source: 'automation', permissionMode: 'acceptEdits', costUsd: 0.8 }];
  const f = rec.facts({ settings: BASE, usage: usage([1, 1, 1]), plan: plan('max', 'Max 5x', 40, [{ t: 0, v: { weekly_all: 95 } }]), jobs, automations: autos, now: NOW });
  assert.strictEqual(f.automations.enabled, 1);
  assert.strictEqual(f.plan.weeklyPeak, 95);
  const items = rec.recommend(f, BASE);
  for (const id of ['approval-gate', 'plan-weekly', 'plan-session', 'plan-pace', 'safety']) assert.ok(ids(items).includes(id), id);
  assert.strictEqual(items[0].priority, 'high');
  assert.strictEqual(items.find((i) => i.id === 'budget-daily').priority, 'low'); // 定額プランなので控えめ
  // すでに設定済みなら出さない
  const done = { ...BASE, approvalGate: true, planLimitWeeklyPct: 80 };
  assert.ok(!ids(rec.recommend(f, done)).includes('approval-gate'));
  assert.ok(!ids(rec.recommend(f, done)).includes('plan-weekly'));
});

test('上限より多い日が続くなら、上限の引き上げを勧める', () => {
  const s = { ...BASE, budgetDailyUsd: 5 };
  const f = rec.facts({ settings: s, usage: usage([6, 7, 8, 9, 10, 4]), now: NOW });
  const it = rec.recommend(f, s).find((i) => i.id === 'budget-daily-up');
  assert.ok(it);
  assert.strictEqual(it.patch.budgetDailyUsd, 15);
});

test('オフにした安全の設定は戻すよう勧める', () => {
  const s = { ...BASE, permissionInbox: false, notifyDesktop: false };
  const items = rec.recommend(rec.facts({ settings: s, now: NOW }), s);
  assert.deepStrictEqual(ids(items).sort(), ['inbox', 'notify']);
});

test('Obsidian の Vault を見つけて、書き出し先として勧める(push はしない)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-rec-'));
  fs.mkdirSync(path.join(home, 'SecondBrain', '.obsidian'), { recursive: true });
  fs.mkdirSync(path.join(home, 'code'));
  const vaults = rec.findVaults(home);
  assert.deepStrictEqual(vaults, [path.join(home, 'SecondBrain')]);
  const it = rec.recommend(rec.facts({ settings: BASE, vaults, now: NOW }), BASE).find((i) => i.id === 'export-vault');
  assert.deepStrictEqual(it.patch, { memoryExportVault: path.join(home, 'SecondBrain'), memoryExportMode: 'files' });
  fs.rmSync(home, { recursive: true, force: true });
});

test('プリセットは、いまと違う項目だけを変更案にする', () => {
  const f = rec.facts({ settings: BASE, now: NOW });
  const [it] = rec.preset('safe', f, { ...BASE, approvalGate: true });
  assert.strictEqual(it.source, 'preset');
  assert.ok(!('approvalGate' in it.patch));
  assert.strictEqual(it.patch.auditDays, 90);
  assert.strictEqual(rec.preset('save', f, BASE)[0].patch.budgetJobUsd, 1);
  assert.throws(() => rec.preset('nope', f, BASE), /プリセット/);
  assert.deepStrictEqual(rec.presets().map((p) => p.id), ['save', 'unattended', 'safe']);
});

test('AI への依頼文には、パスや書き出し先を含めない', () => {
  const s = { ...BASE, memoryExportVault: '/home/me/Secret' };
  const s2 = { ...s, memoryExportVault: '' };
  const f = rec.facts({ settings: s2, vaults: ['/home/me/MyNotes'], now: NOW });
  const rules = rec.recommend(f, s2);
  assert.ok(rules.some((r) => r.id === 'export-vault'));
  const p = rec.aiPrompt(f, rules);
  assert.ok(!p.includes('/home/me'));
  assert.ok(!p.includes('MyNotes'));
  assert.ok(!rec.aiPrompt(rec.facts({ settings: s, now: NOW }), []).includes('Secret'));
  assert.ok(!p.includes('memoryExportVault'));
  assert.ok(p.includes('approvalGate'));
});

test('AI の答えは、知らないキー・範囲外・いまと同じ値を落として読む', () => {
  const raw = '前置き {"summary":"無人ジョブが多い使い方です。","items":[' +
    '{"id":"Gate!","title":"ゲート","patch":{"approvalGate":true,"busEnabled":false,"memoryExportMode":"push"},"reason":"r","priority":"high"},' +
    '{"id":"w","patch":{"planLimitWeeklyPct":250},"priority":"zzz"},' +
    '{"id":"same","patch":{"auditDays":30}},' +
    '{"id":"proto","patch":{"constructor":1,"toString":true,"__proto__":{"approvalGate":true}}},' +
    '{"id":"bad","patch":"x"}]} 後ろ';
  const r = rec.parseAi(raw, BASE);
  assert.strictEqual(r.summary, '無人ジョブが多い使い方です。');
  assert.deepStrictEqual(ids(r.items), ['gate', 'w']);
  assert.deepStrictEqual(r.items[0].patch, { approvalGate: true });
  assert.strictEqual(r.items[0].source, 'ai');
  assert.strictEqual(r.items[1].patch.planLimitWeeklyPct, 100);
  assert.strictEqual(r.items[1].priority, 'mid');
  assert.strictEqual(rec.parseAi('答えられません', BASE), null);
  assert.strictEqual(rec.parseAi('{壊れた', BASE), null);
});
