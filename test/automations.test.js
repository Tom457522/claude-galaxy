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
