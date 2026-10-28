'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tempHome } = require('./helpers');

tempHome();
const { createBus } = require('../bus');

test('宛先ごとの受信と既読', () => {
  const bus = createBus({ onChange() {} });
  bus.send({ from: 's1', fromName: 'a', to: 's2', toName: 'b', text: 'hi' });
  bus.send({ from: 's1', fromName: 'a', to: 'all', toName: '全員', text: 'everyone' });
  assert.strictEqual(bus.unreadCount('s2'), 2);
  assert.strictEqual(bus.unreadCount('s1'), 0); // 自分の全員宛ては数えない
  assert.strictEqual(bus.unreadCount('s3'), 1);
  assert.strictEqual(bus.inbox('s2').length, 2);
  assert.strictEqual(bus.unreadCount('s2'), 0);
  assert.strictEqual(bus.unreadCount('s3'), 1); // 全員宛ての既読は人ごと
  assert.strictEqual(bus.inbox('s2', { unreadOnly: false, markRead: false }).length, 2);
  assert.throws(() => bus.send({ from: 's1', to: 's2', text: '  ' }), /空/);
});

test('共有メモリの読み書きと検索', () => {
  const bus = createBus({ onChange() {} });
  bus.memWrite('proj/decision', 'PostgreSQL を使う', { tags: ['db'], author: 's1' });
  bus.memWrite('proj/todo', 'テストを書く', { author: 's2' });
  assert.strictEqual(bus.memRead('proj/decision').value, 'PostgreSQL を使う');
  assert.deepStrictEqual(bus.memSearch('postgresql').map((m) => m.key), ['proj/decision']);
  assert.deepStrictEqual(bus.memSearch('db').map((m) => m.key), ['proj/decision']); // タグ
  assert.strictEqual(bus.memSearch('', { prefix: 'proj/' }).length, 2);
  assert.ok(bus.memDelete('proj/todo'));
  assert.strictEqual(bus.memRead('proj/todo'), null);
  assert.throws(() => bus.memWrite('  ', 'x'), /キー/);
});

test('共有メモリに書いたエージェント(source)を残す', () => {
  const bus = createBus({ onChange() {} });
  bus.memWrite('a/1', '要約', { author: 'x (j1)', source: { kind: 'job', id: 'j1' } });
  bus.memWrite('a/2', '古い形式', { author: 'y' });
  bus.memWrite('a/3', '不正な source', { source: { kind: 'other', id: 'z' } });
  assert.deepStrictEqual(bus.memRead('a/1').source, { kind: 'job', id: 'j1' });
  assert.deepStrictEqual(bus.memSearch('要約')[0].source, { kind: 'job', id: 'j1' });
  assert.strictEqual(bus.memRead('a/2').source, undefined); // source なしでも読める
  assert.strictEqual(bus.memRead('a/3').source, undefined);
});
