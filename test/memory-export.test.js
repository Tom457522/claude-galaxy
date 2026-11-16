'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempHome } = require('./helpers');

const home = tempHome();
const { exportTo, fileName, secretReason, buildNote, hasMark, SUBDIR, MARK } = require('../memory-export');

const NOW = new Date(2026, 10, 7, 12).getTime();
const e = (key, value, extra = {}) => ({ key, value, tags: [], priority: 'normal', verified: true, expires: '', updatedAt: NOW, author: 'あなた', ...extra });

test('ファイル名は SecondBrain の決まりで全角にする', () => {
  assert.strictEqual(fileName('方針/テスト'), '方針／テスト');
  assert.strictEqual(fileName('a:b*c?"d"<e>|f#g^h[i]'), 'a：b＊c？”d”＜e＞｜f＃g＾h［i］');
  assert.strictEqual(fileName('../x'), '．．／x');
  assert.strictEqual(fileName('a\nb'), 'a b');
  assert.strictEqual(fileName('   '), '名前なし');
});

test('秘密らしい文字列を見つける', () => {
  assert.match(secretReason('key は sk-ant-abcdefghijklmnopqrstuvwxyz です'), /API キー/);
  assert.match(secretReason('ghp_abcdefghijklmnopqrstuvwxyz0123'), /GitHub/);
  assert.match(secretReason('password: hunter22'), /パスワード/);
  assert.match(secretReason('-----BEGIN OPENSSH PRIVATE KEY-----'), /秘密鍵/);
  assert.strictEqual(secretReason('npm test を通す。トークン方式にする'), '');
});

test('ノートの形(フロントマター・目印)', () => {
  const n = buildNote(e('方針/テスト', '本文\n- 箇条書き', { priority: 'must', expires: '2026-12-31', tags: ['db test', '#x'] }));
  assert.match(n, /^---\ntype: agent-memory\nkey: "方針\/テスト"\npriority: must\nverified: true\nexpires: 2026-12-31\nupdated: 2026-11-07\n/);
  assert.match(n, /tags: \["agent-memory","必須","db-test","x"\]/);
  assert.ok(n.split('\n').includes(MARK));
  assert.match(n, /# 方針\/テスト\n/);
  assert.match(n, /本文\n- 箇条書き\n$/);
});

test('書き出し: 確認済み・期限内だけ、変わったものだけ書き、Galaxy のノートだけ消す', () => {
  const vault = path.join(home, `vault-${Date.now()}`);
  const dir = path.join(vault, SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '自分のノート.md'), '---\ntype: moc\n---\n自分で書いた');
  fs.writeFileSync(path.join(dir, '衝突.md'), '自分で書いた同名のノート');
  const list = [
    e('方針/テスト', 'npm test'),
    e('未確認', 'x', { verified: false }),
    e('期限切れ', 'x', { expires: '2026-11-06' }),
    e('秘密', 'token=abcdef123456'),
    e('衝突', 'galaxy の本文'),
  ];
  let r = exportTo(vault, list, { now: NOW });
  assert.deepStrictEqual(r.written, ['方針／テスト.md']);
  assert.strictEqual(r.exported, 1);
  assert.deepStrictEqual(r.blocked.map((b) => b.key).sort(), ['秘密', '衝突.md']);
  assert.strictEqual(fs.readFileSync(path.join(dir, '衝突.md'), 'utf8'), '自分で書いた同名のノート'); // 上書きしない
  // 2 回目は変わらない
  r = exportTo(vault, list, { now: NOW });
  assert.deepStrictEqual(r.written, []);
  assert.strictEqual(r.unchanged, 1);
  // 項目がなくなったら Galaxy のノートだけ消す
  r = exportTo(vault, [], { now: NOW });
  assert.deepStrictEqual(r.removed, ['方針／テスト.md']);
  assert.ok(fs.existsSync(path.join(dir, '自分のノート.md')));
  assert.ok(fs.existsSync(path.join(dir, '衝突.md')));
});

test('印はフロントマターの中だけで見る・名前の細かい決まり・追加の秘密の形', () => {
  assert.strictEqual(hasMark(`---\ntype: agent-memory\n${MARK}\n---\n本文`), true);
  assert.strictEqual(hasMark(`---\ntype: moc\n---\n${MARK}`), false); // 本文にあるだけ
  assert.strictEqual(hasMark(`${MARK}\n`), false);
  assert.strictEqual(fileName('CON'), '_CON');
  assert.strictEqual(fileName('末尾.'), '末尾．');
  assert.match(secretReason('Authorization: Bearer abcdefghijklmnop1234'), /認証ヘッダー/);
  assert.match(secretReason('postgres://me:pa55word@db.local/x'), /URL/);
  assert.match(secretReason('OPENAI_API_KEY=abcdef12345'), /秘密|トークン/);
  assert.match(secretReason('MY_SECRET = abcdef12345'), /秘密|トークン/);
});

test('書き出し: 本文に印があるだけの自分のノートは消さない・大文字小文字の重複を避ける・author も検査する', () => {
  const vault = path.join(home, `vault2-${Date.now()}`);
  const dir = path.join(vault, SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'メモ.md'), `---\ntype: moc\n---\n${MARK}\n`);
  const r = exportTo(vault, [e('Abc', '1'), e('abc', '2'), e('x', 'y', { author: 'token=abcdef123456' })], { now: NOW });
  assert.deepStrictEqual(r.written.sort(), ['Abc.md', 'abc (2).md']);
  assert.deepStrictEqual(r.blocked.map((b) => b.key), ['x']);
  assert.ok(fs.existsSync(path.join(dir, 'メモ.md')));
});
