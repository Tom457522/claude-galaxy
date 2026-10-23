'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempHome } = require('./helpers');

const home = tempHome();
const { createAudit, targetOf } = require('../audit');

test('記録と検索(新しい順・絞り込み)', async () => {
  const settings = { auditEnabled: true, auditDays: 30 };
  const a = createAudit({ getSettings: () => settings });
  a.log({ agent: 's1', agentName: 'lead', kind: 'tool', tool: 'Bash', target: 'npm test' });
  a.log({ agent: 'j2', agentName: 'job', kind: 'tool', tool: 'Edit', target: '/src/app.js' });
  a.log({ agent: 's1', kind: 'permission', tool: 'Bash', detail: '拒否' });
  settings.auditEnabled = false;
  a.log({ agent: 's1', kind: 'tool', tool: 'Read' }); // 記録しない
  a.close();
  await new Promise((r) => setTimeout(r, 100));
  const all = a.query();
  assert.strictEqual(all.length, 3);
  assert.strictEqual(all[0].kind, 'permission');
  assert.strictEqual(a.query({ agent: 's1' }).length, 2);
  assert.strictEqual(a.query({ kind: 'tool' }).length, 2);
  assert.deepStrictEqual(a.query({ q: 'app.js' }).map((e) => e.agent), ['j2']);
});

test('保存期間を過ぎたファイルは消す', () => {
  const dir = path.join(home, '.claude-galaxy', 'audit');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2000-01-01.jsonl'), '{}\n');
  createAudit({ getSettings: () => ({ auditEnabled: true, auditDays: 30 }) }).close();
  assert.ok(!fs.existsSync(path.join(dir, '2000-01-01.jsonl')));
});

test('ツール入力から対象を取り出す', () => {
  assert.strictEqual(targetOf({ command: 'ls -la' }), 'ls -la');
  assert.strictEqual(targetOf({ file_path: '/a/b.js', content: 'secret' }), '/a/b.js');
  assert.strictEqual(targetOf(null), '');
});
