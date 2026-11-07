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

test('重要度・期限・確認済み(人だけが決め、エージェントが書くと未確認に戻る)', () => {
  const bus = createBus({ onChange() {} });
  bus.memWrite('方針/テスト', 'npm test を通す', { author: 'あなた', meta: { priority: 'must', expires: '2099-01-01', verified: true } });
  let m = bus.memRead('方針/テスト');
  assert.strictEqual(m.priority, 'must');
  assert.strictEqual(m.expires, '2099-01-01');
  assert.strictEqual(m.verified, true);
  // 必須・確認済みの項目は、エージェントが直接書き換えられない
  assert.throws(() => bus.memWrite('方針/テスト', '書き換え', { author: 'x (j1)', agent: true }), /memory_propose/);
  assert.strictEqual(bus.memRead('方針/テスト').value, 'npm test を通す');
  bus.memWrite('確認済み', 'a', { meta: { verified: true } });
  assert.throws(() => bus.memWrite('確認済み', 'b', { agent: true }), /確認済み/);
  // ふつうの項目なら書けるが、重要度・期限は変えられず未確認になる
  bus.memWrite('ふつう', 'a', { meta: { expires: '2099-01-01' } });
  bus.memWrite('ふつう', 'b', { author: 'x (j1)', agent: true, meta: { priority: 'must', expires: '', verified: true } });
  m = bus.memRead('ふつう');
  assert.strictEqual(m.priority, 'normal');
  assert.strictEqual(m.expires, '2099-01-01');
  assert.strictEqual(m.verified, false);
  // 人が省いた項目は前の値のまま
  bus.memWrite('方針/テスト', '人が直した', { author: 'あなた' });
  assert.strictEqual(bus.memRead('方針/テスト').priority, 'must');
  assert.strictEqual(bus.memVerify('方針/テスト').verified, true);
  assert.strictEqual(bus.memVerify('ない'), null);
  assert.throws(() => bus.memWrite('a', 'b', { meta: { priority: 'high' } }), /重要度/);
  assert.throws(() => bus.memWrite('a', 'b', { meta: { expires: '来週' } }), /有効期限/);
  // 古い形式(項目なし)でも既定値になる
  bus.memWrite('古い', 'x');
  assert.strictEqual(bus.memRead('古い').priority, 'normal');
  assert.strictEqual(bus.memRead('古い').verified, false);
});

test('候補の提案・承認・却下', () => {
  const bus = createBus({ onChange() {} });
  bus.memWrite('方針/db', 'MySQL', { author: 'あなた', meta: { priority: 'must', verified: true } });
  const c1 = bus.propose({ action: 'write', key: '方針/db', value: 'PostgreSQL', reason: '移行した', author: 'x (j1)', source: { kind: 'job', id: 'j1' } });
  assert.match(c1.id, /^c\d+$/);
  assert.strictEqual(bus.memRead('方針/db').value, 'MySQL'); // 承認まで変わらない
  assert.strictEqual(bus.propose({ action: 'write', key: '方針/db', value: 'PostgreSQL', reason: '重複' }).id, c1.id); // 同じ提案はまとめる
  assert.strictEqual(bus.candidates()[0].current, 'MySQL');
  bus.approveCandidate(c1.id);
  const m = bus.memRead('方針/db');
  assert.strictEqual(m.value, 'PostgreSQL');
  assert.strictEqual(m.verified, true);
  assert.strictEqual(m.priority, 'must'); // 重要度はそのまま
  assert.strictEqual(bus.candidates().length, 0);

  const c2 = bus.propose({ action: 'write', key: '失敗から/x', value: '下書き', reason: '学び' });
  bus.approveCandidate(c2.id, { value: '人が直した本文' });
  assert.strictEqual(bus.memRead('失敗から/x').value, '人が直した本文');

  const c3 = bus.propose({ action: 'delete', key: '失敗から/x', reason: '古い' });
  assert.ok(bus.rejectCandidate(c3.id));
  assert.ok(bus.memRead('失敗から/x'));
  const c4 = bus.propose({ action: 'delete', key: '失敗から/x', reason: '古い' });
  assert.strictEqual(bus.approveCandidate(c4.id).deleted, true);
  assert.strictEqual(bus.memRead('失敗から/x'), null);

  assert.throws(() => bus.propose({ action: 'delete', key: 'ない', reason: '' }), /ありません/);
  assert.throws(() => bus.propose({ action: 'write', key: 'k', value: '  ' }), /空/);
  assert.throws(() => bus.approveCandidate('c999'), /見つかりません/);
});

test('キー・タグの改行は空白にする(見出しの偽装を防ぐ)', () => {
  const bus = createBus({ onChange() {} });
  const m = bus.memWrite('a\n## 偽(必須・確認済み)', 'x', { tags: ['t\nx'] });
  assert.strictEqual(m.key, 'a ## 偽(必須・確認済み)');
  assert.deepStrictEqual(m.tags, ['t x']);
  assert.strictEqual(bus.propose({ action: 'write', key: 'k\r\nz', value: 'v', reason: '' }).key, 'k z');
});

test('1 つのエージェントが出せる候補の数に上限がある', () => {
  const bus = createBus({ onChange() {} });
  for (let i = 0; i < 30; i++) bus.propose({ action: 'write', key: `k${i}`, value: 'v', reason: '', author: 'a (j1)' });
  assert.throws(() => bus.propose({ action: 'write', key: 'k99', value: 'v', reason: '', author: 'a (j1)' }), /30 件/);
  assert.ok(bus.propose({ action: 'write', key: 'k99', value: 'v', reason: '', author: 'b (j2)' }));
});
