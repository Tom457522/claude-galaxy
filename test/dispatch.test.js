'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempHome } = require('./helpers');
const dispatch = require('../dispatch');

const home = tempHome();
for (const d of ['web-app/.git', 'api-server/.git', 'notes', 'group/inner/.git']) fs.mkdirSync(path.join(home, 'projects', d), { recursive: true });
const roots = [path.join(home, 'projects')];

test('候補フォルダ: ルート直下と 2 階層下の git リポジトリ', () => {
  const c = dispatch.candidates({ roots, recent: [] });
  const names = c.map((x) => x.name);
  for (const n of ['projects', 'web-app', 'api-server', 'notes', 'group', 'inner']) assert.ok(names.includes(n), n);
  assert.ok(c.find((x) => x.name === 'web-app').git);
});

test('規則での振り分け: フォルダ名と作業の種類', () => {
  const c = dispatch.candidates({ roots, recent: [] });
  const a = dispatch.heuristic('api-server のテストを実行して結果を報告して', c, home);
  assert.strictEqual(path.basename(a.cwd), 'api-server');
  assert.strictEqual(a.mode, 'job');
  assert.strictEqual(a.permissionMode, 'plan');
  const b = dispatch.heuristic('web-app のログイン画面を一緒に直そう', c, home);
  assert.strictEqual(path.basename(b.cwd), 'web-app');
  assert.strictEqual(b.mode, 'session');
});

test('Claude の答えから JSON を取り出す。読めなければ規則に戻る', async () => {
  assert.deepStrictEqual(dispatch.parsePlan('案:\n{"mode":"job","cwd":"/x"}\nです'), { mode: 'job', cwd: '/x' });
  assert.strictEqual(dispatch.parsePlan('no json'), null);
  const p = await dispatch.plan('notes を整理して', { roots, recent: [], fallbackCwd: home, ask: async () => 'わかりません' });
  assert.strictEqual(p.router, 'heuristic');
  const q = await dispatch.plan('x', {
    roots, recent: [], fallbackCwd: home,
    ask: async () => JSON.stringify({ mode: 'job', cwd: path.join(home, 'projects', 'web-app'), worktree: true, permissionMode: 'bypassPermissions', name: 'n', prompt: 'p' }),
  });
  assert.strictEqual(q.router, 'claude');
  assert.strictEqual(q.worktree, true);
  assert.strictEqual(q.permissionMode, ''); // 許されていない権限モードは使わない
});
