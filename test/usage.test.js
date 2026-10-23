'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempHome } = require('./helpers');

const home = tempHome();
const { UsageTracker, costOf, createUsageScanner } = require('../usage');

const line = (id, model, input, output, cw = 0, cr = 0) => JSON.stringify({
  type: 'assistant', message: { id, model, usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cw, cache_read_input_tokens: cr } },
});

test('同じ message.id は最後の行だけ数え、追記分だけ読む', () => {
  const file = path.join(home, 'sess.jsonl');
  fs.writeFileSync(file, `${line('m1', 'claude-opus-5-5', 1000, 100)}\n${line('m1', 'claude-opus-5-5', 1000, 500)}\n`);
  const t = new UsageTracker();
  t.addFile(file);
  assert.ok(t.refresh());
  assert.strictEqual(t.totals.input, 1000);
  assert.strictEqual(t.totals.output, 500);
  assert.ok(Math.abs(t.totals.cost - 0.014) < 1e-9); // 1000*4 + 500*20
  assert.strictEqual(t.refresh(), false); // 変化なし
  fs.appendFileSync(file, `${line('m2', 'claude-sonnet-5-5', 2000, 1000, 1000, 10000)}\n`);
  assert.ok(t.refresh());
  assert.ok(Math.abs(t.totals.cost - 0.0325) < 1e-9);
});

test('サブエージェントのトランスクリプトも拾う', () => {
  const file = path.join(home, 'main.jsonl');
  fs.writeFileSync(file, `${line('a', 'claude-haiku-5-5', 100, 10)}\n`);
  fs.mkdirSync(path.join(home, 'main', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(home, 'main', 'subagents', 'agent-x.jsonl'), `${line('b', 'claude-haiku-5-5', 200, 20)}\n`);
  const t = new UsageTracker();
  t.addFile(file);
  t.refresh();
  assert.strictEqual(t.totals.input, 300);
});

test('Claude Code 全体: 日別・プロジェクト別にまとめ、期間外とサブエージェントの重複を除く', () => {
  const dir = path.join(home, 'projects');
  const now = new Date(2026, 9, 23, 12).getTime();
  const at = (daysAgo) => new Date(2026, 9, 23 - daysAgo, 10).toISOString();
  const row = (id, model, input, output, daysAgo, cwd) => JSON.stringify({
    type: 'assistant', timestamp: at(daysAgo), cwd,
    message: { id, model, usage: { input_tokens: input, output_tokens: output } },
  });
  fs.mkdirSync(path.join(dir, 'p1', 's1', 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'p2'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'p1', 's1.jsonl'), [
    row('a', 'claude-opus-5-5', 1e6, 0, 0, '/w/app'), // 今日 $4
    row('b', 'claude-sonnet-5-5', 1e6, 0, 3, '/w/app'), // 3 日前 $2
    row('old', 'claude-opus-5-5', 1e6, 0, 40, '/w/app'), // 期間外
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'p1', 's1', 'subagents', 'agent-1.jsonl'), [
    row('a', 'claude-opus-5-5', 1e6, 0, 0, '/w/app'), // 本体と重複
    row('c', 'claude-haiku-5-5', 1e6, 0, 0, '/w/app'), // $0.1
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'p2', 's2.jsonl'), `${row('d', 'claude-opus-5-5', 0, 1e5, 1, '/w/other')}\n`); // $2
  const r = createUsageScanner({ dir }).report({ days: 7, now });
  assert.strictEqual(r.files, 3);
  assert.strictEqual(r.daily.length, 7);
  assert.strictEqual(r.daily[6].day, '2026-10-23');
  assert.ok(Math.abs(r.totals.today - 4.1) < 1e-9);
  assert.ok(Math.abs(r.totals.range - 8.1) < 1e-9);
  assert.ok(Math.abs(r.daily[6].families.opus - 4) < 1e-9);
  assert.ok(Math.abs(r.daily[6].families.haiku - 0.1) < 1e-9);
  assert.deepStrictEqual(r.projects.map((p) => [p.cwd, p.sessions]), [['/w/app', 1], ['/w/other', 1]]);
  assert.strictEqual(r.sessions[0].id, 's1');
  // プランの制限の期間: 今日の 0 時から 1 時間ごと(重複は 1 回だけ)
  const from = new Date(2026, 9, 23).getTime();
  const w = createUsageScanner({ dir }).between({ from, to: now });
  assert.strictEqual(w.buckets.length, 12);
  assert.ok(Math.abs(w.cost - 4.1) < 1e-9);
  assert.ok(Math.abs(w.buckets[10].cost - 4.1) < 1e-9); // 10 時台
});

test('単価がわからないモデルは数えない', () => {
  assert.strictEqual(costOf('some-other-model', { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }), null);
  assert.ok(costOf('us.anthropic.claude-opus-5-5', { input: 1e6, output: 0, cacheWrite: 0, cacheRead: 0 }) === 4);
});

test('pricing.json で単価を上書きできる', () => {
  fs.mkdirSync(path.join(home, '.claude-galaxy'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude-galaxy', 'pricing.json'), JSON.stringify({ 'my-model': { input: 1, output: 2 } }));
  delete require.cache[require.resolve('../usage')];
  const u = require('../usage');
  assert.strictEqual(u.costOf('my-model-v1', { input: 1e6, output: 1e6, cacheWrite: 0, cacheRead: 0 }), 3);
});

test('1 時間キャッシュの書き込みは input の 2 倍で数える', () => {
  // Claude Code のクラウドセッションが出した額($0.2959)と同じになる
  const u = { input: 6, output: 1282, cacheWrite: 29189, cacheWrite1h: 29189, cacheRead: 183521 };
  assert.ok(Math.abs(costOf('claude-opus-5-5', u) - 0.2958802) < 1e-4);
  assert.ok(costOf('claude-opus-5-5', { ...u, cacheWrite1h: 0 }) < 0.21); // 5 分キャッシュなら 1.25 倍
});
