'use strict';
// git の補助: 作業ディレクトリの差分と、エージェントごとの worktree(別ブランチの作業コピー)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const MAX_DIFF = 1024 * 1024; // 画面に出す差分の上限(文字数)

function git(cwd, args, { allowFail = false, maxBuffer = 16 * 1024 * 1024 } = {}) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 20000, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (allowFail) return null;
    const msg = (e.stderr && String(e.stderr).trim()) || e.message;
    throw new Error(`git ${args[0]} に失敗しました: ${msg.split('\n')[0]}`);
  }
}

function repoRoot(cwd) {
  const out = git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true });
  return out ? path.resolve(out.trim()) : null;
}

// base(コミット)から作業ツリーまでの差分。未追跡のファイルは一覧だけ返す
function diff(cwd, base) {
  const root = repoRoot(cwd);
  if (!root) return { repo: null, error: 'git リポジトリではありません' };
  const head = (git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true }) || '').trim();
  const from = base && /^[0-9a-f]{7,64}$/i.test(base) ? base : head;
  const branch = (git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) || '').trim();
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']) || '';
  const untracked = status.split('\n').filter((l) => l.startsWith('?? ')).map((l) => l.slice(3)).slice(0, 500);
  let stat = '';
  let text = '';
  if (from) {
    stat = git(root, ['diff', '--stat=200', from]) || '';
    text = git(root, ['diff', '--no-color', '-M', from], { maxBuffer: 64 * 1024 * 1024 }) || '';
  }
  text += untrackedDiff(root, untracked);
  const commits = from && head && from !== head
    ? (git(root, ['log', '--oneline', '-n', '50', `${from}..${head}`], { allowFail: true }) || '').trim().split('\n').filter(Boolean)
    : [];
  return {
    repo: root,
    branch,
    base: from || null,
    head: head || null,
    commits,
    stat: stat.trim(),
    diff: text.length > MAX_DIFF ? text.slice(0, MAX_DIFF) : text,
    truncated: text.length > MAX_DIFF,
    untracked,
  };
}

// 未追跡のファイルは git diff に出ないので、小さいテキストファイルだけ「新規ファイル」として差分の形にする
function untrackedDiff(root, files) {
  let out = '';
  for (const f of files.slice(0, 30)) {
    const abs = path.join(root, f);
    let buf;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 64 * 1024) { out += `diff --git a/${f} b/${f}\nnew file (大きいため省略)\n`; continue; }
      buf = fs.readFileSync(abs);
    } catch (_) { continue; }
    if (buf.includes(0)) { out += `diff --git a/${f} b/${f}\nnew file (バイナリ)\n`; continue; }
    const lines = buf.toString('utf8').replace(/\n$/, '').split('\n');
    out += `diff --git a/${f} b/${f}\nnew file\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
  }
  return out;
}

const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'wt';

// 新しい worktree を作る。branch: galaxy/<id>、置き場所: <dir>/<リポジトリ名>-<id>
function createWorktree(cwd, id, dir) {
  const root = repoRoot(cwd);
  if (!root) throw new Error(`worktree を作るには git リポジトリが必要です: ${cwd}`);
  const head = (git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true }) || '').trim();
  if (!head) throw new Error('コミットがまだないリポジトリでは worktree を作れません');
  const baseDir = dir || path.join(os.homedir(), '.claude-galaxy', 'worktrees');
  fs.mkdirSync(baseDir, { recursive: true });
  const wtPath = path.join(baseDir, `${safeName(path.basename(root))}-${safeName(id)}`);
  if (fs.existsSync(wtPath)) throw new Error(`worktree の置き場所がすでにあります: ${wtPath}`);
  let branch = `galaxy/${safeName(id)}`;
  if (git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true })) branch = `${branch}-${Date.now().toString(36)}`;
  git(root, ['worktree', 'add', '-b', branch, wtPath, head]);
  // サブフォルダで起動していたら、worktree の中でも同じサブフォルダにする
  // macOS の /var → /private/var のようなシンボリックリンクがあっても比べられるよう、実体のパスで比べる
  const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
  const rel = path.relative(real(root), real(cwd));
  // (空のフォルダは git に入らないので、なければ作る)
  const workdir = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join(wtPath, rel) : wtPath;
  try { fs.mkdirSync(workdir, { recursive: true }); } catch (_) { /* ignore */ }
  return { repo: root, path: wtPath, cwd: fs.existsSync(workdir) ? workdir : wtPath, branch, base: head, createdAt: Date.now() };
}

// worktree を片付ける。force: 変更が残っていても消す。ブランチは残す(マージ前の変更を失わないため)
function removeWorktree(info, { force = false } = {}) {
  if (!info || !info.repo || !info.path) throw new Error('worktree の情報がありません');
  if (!fs.existsSync(info.path)) {
    git(info.repo, ['worktree', 'prune'], { allowFail: true });
    return { removed: true, branch: info.branch };
  }
  const dirty = (git(info.path, ['status', '--porcelain'], { allowFail: true }) || '').trim();
  if (dirty && !force) throw new Error('worktree にコミットしていない変更があります。消す場合は「変更ごと削除」を選んでください');
  git(info.repo, ['worktree', 'remove', ...(force ? ['--force'] : []), info.path]);
  return { removed: true, branch: info.branch };
}

module.exports = { diff, repoRoot, createWorktree, removeWorktree };
