'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tempHome } = require('./helpers');

tempHome();
const { normalize } = require('../jobs');

test('ジョブの入力を検査する', () => {
  const j = normalize({ prompt: 'テストを直して\n詳しく', allowedTools: 'Bash(npm test:*)\nEdit', maxBudgetUsd: '2' });
  assert.strictEqual(j.name, 'テストを直して');
  assert.deepStrictEqual(j.allowedTools, ['Bash(npm test:*)', 'Edit']);
  assert.strictEqual(j.maxBudgetUsd, 2);
  assert.strictEqual(j.priority, 'normal');
  assert.throws(() => normalize({ prompt: '' }), /プロンプト/);
  assert.throws(() => normalize({ prompt: 'x', model: 'opus; rm -rf /' }), /モデル/);
  assert.throws(() => normalize({ prompt: 'x', allowedTools: ['Bash($(evil))'] }), /許可ツール/);
  assert.throws(() => normalize({ prompt: 'x', permissionMode: 'yolo' }), /権限モード/);
  assert.throws(() => normalize({ prompt: 'x', maxBudgetUsd: -1 }), /予算/);
});

test('エージェントから登録するジョブ(strict)は強い権限を使えない', () => {
  assert.throws(() => normalize({ prompt: 'x', permissionMode: 'bypassPermissions' }, { strict: true }), /使えません/);
  assert.throws(() => normalize({ prompt: 'x', permissionMode: 'auto' }, { strict: true }), /使えません/);
  assert.throws(() => normalize({ prompt: 'x', allowedTools: ['Edit'] }, { strict: true }), /使えません/);
  assert.strictEqual(normalize({ prompt: 'x', permissionMode: 'acceptEdits' }, { strict: true }).permissionMode, 'acceptEdits');
});
