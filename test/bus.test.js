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
