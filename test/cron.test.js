'use strict';
const test = require('node:test');
const assert = require('node:assert');
const cron = require('../cron');

test('次の実行時刻を計算できる', () => {
  const from = new Date(2026, 9, 23, 10, 0); // 2026-10-23(金) 10:00
  assert.deepStrictEqual(cron.next(cron.parse('30 9 * * 1-5'), from), new Date(2026, 9, 26, 9, 30)); // 月曜 9:30
  assert.deepStrictEqual(cron.next(cron.parse('*/15 * * * *'), new Date(2026, 9, 23, 10, 7)), new Date(2026, 9, 23, 10, 15));
  assert.deepStrictEqual(cron.next(cron.parse('@monthly'), from), new Date(2026, 10, 1, 0, 0));
});

test('日と曜日の両方を指定したら、どちらかに一致すれば実行', () => {
  const c = cron.parse('0 0 1 * 1');
  assert.ok(cron.matches(c, new Date(2026, 9, 1, 0, 0))); // 1 日(木)
  assert.ok(cron.matches(c, new Date(2026, 9, 26, 0, 0))); // 月曜
  assert.ok(!cron.matches(c, new Date(2026, 9, 27, 0, 0)));
});

test('曜日の 7 は日曜', () => {
  assert.ok(cron.matches(cron.parse('0 12 * * 7'), new Date(2026, 9, 25, 12, 0)));
});

test('不正な式はエラー', () => {
  assert.throws(() => cron.parse('61 * * * *'), /範囲/);
  assert.throws(() => cron.parse('* * *'), /5 つ/);
  assert.throws(() => cron.parse('a * * * *'), /読めません/);
});
