'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempHome } = require('./helpers');

const home = tempHome();
const { UsageTracker, costOf } = require('../usage');

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
