'use strict';
// git の補助: 作業ディレクトリの差分と、エージェントごとの worktree(別ブランチの作業コピー)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const MAX_DIFF = 1024 * 1024; // 画面に出す差分の上限(文字数)

function git(cwd, args, { allowFail = false, maxBuffer = 16 * 1024 * 1024, timeout = 20000 } = {}) {
  try {
    // 認証を聞かれても止まらないようにする(画面からは答えられないため)
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout, maxBuffer, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

// ---- 取り込み(コミット・マージ・push)----
const isDirty = (dir) => !!(git(dir, ['status', '--porcelain'], { allowFail: true }) || '').trim();

// worktree の変更をすべてコミットする(変更がなければ何もしない)
function commitAll(info, message) {
  if (!info || !fs.existsSync(info.path)) throw new Error('worktree がありません');
  if (!isDirty(info.path)) return { committed: false };
  const msg = String(message || '').trim() || `Claude Galaxy: ${info.branch} の変更`;
  git(info.path, ['add', '-A']);
  git(info.path, ['-c', 'user.name=Claude Galaxy', '-c', 'user.email=claude-galaxy@localhost', 'commit', '-q', '-m', msg]);
  return { committed: true, commit: git(info.path, ['rev-parse', '--short', 'HEAD']).trim() };
}

// worktree のブランチを、元のリポジトリでいま開いているブランチに取り込む
//   元のリポジトリに未コミットの変更があるとき・競合したときは、何も変えずに止める
function mergeInto(info, { squash = false, message = '' } = {}) {
  const repo = info.repo;
  const into = (git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim();
  if (!into || into === 'HEAD') throw new Error('元のリポジトリがブランチを開いていません(detached HEAD)');
  if (into === info.branch) throw new Error('取り込み先が同じブランチです');
  const tracked = (git(repo, ['status', '--porcelain', '--untracked-files=no']) || '').trim();
  if (tracked) throw new Error(`元のリポジトリ(${into})にコミットしていない変更があります。先にコミットか stash をしてください`);
  const ahead = (git(repo, ['rev-list', '--count', `${into}..${info.branch}`]) || '0').trim();
  if (ahead === '0') throw new Error(`${info.branch} に、${into} へ取り込むコミットがありません(先にコミットしてください)`);
  const who = ['-c', 'user.name=Claude Galaxy', '-c', 'user.email=claude-galaxy@localhost'];
  const msg = String(message || '').trim() || `Merge ${info.branch} (Claude Galaxy)`;
  try {
    if (squash) {
      git(repo, ['merge', '--squash', info.branch]);
      git(repo, [...who, 'commit', '-q', '-m', msg]);
    } else {
      git(repo, [...who, 'merge', '--no-ff', '-m', msg, info.branch]);
    }
  } catch (e) {
    const conflicts = (git(repo, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }) || '').trim().split('\n').filter(Boolean);
    git(repo, ['merge', '--abort'], { allowFail: true });
    if (squash) git(repo, ['reset', '--hard', 'HEAD'], { allowFail: true });
    if (conflicts.length) throw new Error(`競合したため取り込みをやめました(元のリポジトリは元のままです): ${conflicts.join(', ')}`);
    throw e;
  }
  return { merged: true, into, commits: Number(ahead), commit: git(repo, ['rev-parse', '--short', 'HEAD']).trim() };
}

// リモートの URL から、PR を作る画面の URL を作る(GitHub / GitLab / Bitbucket)
function compareUrl(remote, base, branch) {
  const m = /^(?:git@|ssh:\/\/git@|https?:\/\/(?:[^@/]+@)?)([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(String(remote || '').trim());
  if (!m) return null;
  const [, host, repoPath] = m;
  const enc = (x) => encodeURIComponent(x).replace(/%2F/g, '/'); // ブランチ名の / はそのまま
  const b = enc(branch);
  if (/github/.test(host)) return `https://${host}/${repoPath}/compare/${base ? `${enc(base)}...` : ''}${b}?expand=1`;
  if (/gitlab/.test(host)) return `https://${host}/${repoPath}/-/merge_requests/new?merge_request[source_branch]=${b}${base ? `&merge_request[target_branch]=${enc(base)}` : ''}`;
  if (/bitbucket/.test(host)) return `https://${host}/${repoPath}/pull-requests/new?source=${b}`;
  return null;
}

// worktree のブランチを origin へ push し、PR 作成画面の URL を返す
function pushBranch(info) {
  const remote = (git(info.repo, ['remote', 'get-url', 'origin'], { allowFail: true }) || '').trim();
  if (!remote) throw new Error('リモート origin がありません');
  const base = (git(info.repo, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) || '').trim();
  git(info.path, ['push', '-u', 'origin', info.branch], { timeout: 120000 });
  return { pushed: true, branch: info.branch, remote, url: compareUrl(remote, base && base !== 'HEAD' ? base : '', info.branch) };
}

module.exports = { diff, repoRoot, createWorktree, removeWorktree, commitAll, mergeInto, pushBranch, compareUrl };
