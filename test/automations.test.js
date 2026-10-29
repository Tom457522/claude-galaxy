'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tempHome } = require('./helpers');

const home = tempHome();
const { createAutomations } = require('../automations');

function setup() {
  const submitted = [];
  const a = createAutomations({
    resolveCwd: (p) => p || home,
    submit: (t, meta) => { const j = { id: `j${submitted.length + 1}`, ...t, ...meta }; submitted.push(j); return j; },
    isActive: () => false,
    jobEndedAt: () => null,
    onChange() {},
    onRemove() {},
  });
  return { a, submitted };
}

test('ジョブのあとに動かす: 結果を渡し、条件と深さを守る', () => {
  const { a, submitted } = setup();
  const first = a.create({ name: 'build', kind: 'cron', cron: '0 3 * * *', template: { prompt: 'build it', cwd: home } });
  const second = a.create({ name: 'review', kind: 'after', afterAutomationId: first.id, template: { prompt: 'review: {{prevResult}} ({{prevStatus}})' } });
  assert.throws(() => a.create({ name: 'x', kind: 'after', afterAutomationId: 'anone', template: { prompt: 'x' } }), /見つかりません/);
  assert.throws(() => a.update(second.id, { afterAutomationId: second.id }), /自分自身/);

  a.onJobFinished({ id: 'j9', name: 'build', automationId: first.id, status: 'done', result: 'built OK', cwd: '/w', chainDepth: 0 });
  assert.strictEqual(submitted.length, 1);
  assert.strictEqual(submitted[0].prompt, 'review: built OK (done)');
  assert.strictEqual(submitted[0].cwd, '/w');
  assert.strictEqual(submitted[0].chainDepth, 1);

  a.onJobFinished({ id: 'j10', automationId: first.id, status: 'failed', error: 'x', cwd: '/w' }); // 完了のときだけ
  a.onJobFinished({ id: 'j11', automationId: first.id, status: 'done', cwd: '/w', chainDepth: 10 }); // 深すぎる
  a.onJobFinished({ id: 'j12', automationId: second.id, status: 'done', cwd: '/w' }); // つながっていない
  assert.strictEqual(submitted.length, 1);
  a.update(second.id, { afterStatus: 'any' });
  a.onJobFinished({ id: 'j13', automationId: first.id, status: 'failed', error: 'boom', cwd: '/w' });
  assert.strictEqual(submitted.length, 2);
  assert.match(submitted[1].prompt, /boom \(failed\)/);
});

test('時刻: 逃した予定は次の確認で 1 回だけ実行し、その時刻ちょうどなら通常どおり 1 回', () => {
  const { a, submitted: all } = setup(); // 前のテストのオートメーションも読み込まれるので、これの分だけ数える
  const x = a.create({ name: 'nightly', kind: 'cron', cron: '0 22 * * *', template: { prompt: 'run', cwd: home } });
  const created = new Date(x.createdAt);
  const submitted = { get length() { return all.filter((j) => j.automationId === x.id).length; } };
  const at = (days, h, m, sec = 30) => new Date(created.getFullYear(), created.getMonth(), created.getDate() + days, h, m, sec);

  a.tick(at(2, 21, 59)); // 少なくとも 1 日目の 22 時を逃した(作成が 22 時前なら当日の分も) → 1 回だけ
  assert.strictEqual(submitted.length, 1);
  a.tick(at(2, 21, 59, 50));
  assert.strictEqual(submitted.length, 1);
  a.tick(at(2, 22, 0)); // 予定どおり
  assert.strictEqual(submitted.length, 2);
  a.tick(at(2, 22, 1));
  a.tick(at(3, 21, 0));
  assert.strictEqual(submitted.length, 2);
  a.tick(at(5, 8, 0)); // 3 日目・4 日目の 22 時を逃した → 1 回だけ
  assert.strictEqual(submitted.length, 3);
  a.tick(at(5, 8, 1));
  assert.strictEqual(submitted.length, 3);
});
