'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tempHome } = require('./helpers');

tempHome();
const { createBudget } = require('../budget');

test('上限に近づいた・超えたときに 1 回だけ知らせ、ジョブの起動を止める', () => {
  const settings = { budgetDailyUsd: 1 };
  const levels = [];
  const b = createBudget({ getSettings: () => settings, onChange: (_st, level) => { if (level) levels.push(level); } });
  assert.strictEqual(b.blockReason(), '');
  b.add('jobs', 0.5);
  b.add('sessions', 0.35); // 85% → 警告
  b.add('jobs', 0.01); // 同じ警告は出さない
  assert.deepStrictEqual(levels, ['warn']);
  const st = b.status();
  assert.ok(Math.abs(st.spent - 0.86) < 1e-9);
  assert.ok(st.warn && !st.over);
  b.add('jobs', 0.2); // 超えた
  assert.deepStrictEqual(levels, ['warn', 'over']);
  assert.match(b.blockReason(), /予算/);
  settings.budgetDailyUsd = 0; // 上限なし
  assert.strictEqual(b.blockReason(), '');
  b.add('jobs', -1); // 負の値は無視
  assert.ok(Math.abs(b.status().spent - 1.06) < 1e-9);
});
