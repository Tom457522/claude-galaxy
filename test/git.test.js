'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tempHome } = require('./helpers');

const home = tempHome();
const gitx = require('../git');

let hasGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch (_) { hasGit = false; }

function makeRepo() {
  const repo = path.join(home, `repo-${Date.now()}`);
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'ignore' });
  g('init', '-q');
  g('add', '.');
  g('commit', '-qm', 'init');
  return { repo, g };
}

test('差分: 変更・新しいファイル', { skip: !hasGit && 'git がありません' }, () => {
  const { repo } = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'hello\n');
  const d = gitx.diff(repo);
  assert.strictEqual(fs.realpathSync(d.repo), fs.realpathSync(repo));
  assert.match(d.diff, /-one\n\+two/);
  assert.deepStrictEqual(d.untracked, ['new.txt']);
  assert.match(d.diff, /\+\+\+ b\/new.txt\n@@ -0,0 \+1,1 @@\n\+hello/);
  assert.match(gitx.diff(home).error, /git リポジトリではありません/);
});

test('worktree: 作成・差分・削除(ブランチは残る)', { skip: !hasGit && 'git がありません' }, () => {
  const { repo } = makeRepo();
  const wt = gitx.createWorktree(path.join(repo, 'sub'), 's9', path.join(home, 'wts'));
  assert.strictEqual(wt.branch, 'galaxy/s9');
  assert.strictEqual(path.basename(wt.cwd), 'sub'); // サブフォルダも引き継ぐ
  fs.writeFileSync(path.join(wt.path, 'a.txt'), 'changed\n');
  const d = gitx.diff(wt.cwd, wt.base);
  assert.strictEqual(d.branch, 'galaxy/s9');
  assert.match(d.diff, /\+changed/);
  assert.throws(() => gitx.removeWorktree(wt), /変更があります/);
  assert.deepStrictEqual(gitx.removeWorktree(wt, { force: true }), { removed: true, branch: 'galaxy/s9' });
  assert.ok(!fs.existsSync(wt.path));
  assert.match(execFileSync('git', ['-C', repo, 'branch'], { encoding: 'utf8' }), /galaxy\/s9/);
  // 同じ ID でもう一度作ると、ブランチ名が重ならないようにする
  const wt2 = gitx.createWorktree(repo, 's9', path.join(home, 'wts'));
  assert.notStrictEqual(wt2.branch, 'galaxy/s9');
});
