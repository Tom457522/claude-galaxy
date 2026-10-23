'use strict';
// 自然言語の窓口: 「やりたいこと」から、どのフォルダで・どの方法(対話セッション / ジョブ)で・
// worktree を分けるかを決めて、実行案を作る。案は人が確認・修正してから実行する。
//   - まず Claude(小さいモデル・ツールなし)に振り分けさせる
//   - 使えないとき・答えが読めないときは、フォルダ名の一致などの簡単な規則で決める

const fs = require('fs');
const path = require('path');

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '.venv', '__pycache__']);
const JOB_HINTS = /(調べ|調査|レビュー|review|まとめ|要約|集計|一覧|テストを?(実行|回)|lint|チェック|確認して|報告|レポート|ドキュメント|翻訳|分析|audit|探して)/i;
const EDIT_HINTS = /(直し|修正|実装|追加|変更|リファクタ|refactor|fix|implement|書き換え|作って|削除|更新)/i;

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
const hasGit = (p) => fs.existsSync(path.join(p, '.git'));

// 候補フォルダ: ルート(グラフの設定)とその直下・2 階層下の git リポジトリ、最近使ったフォルダ
function candidates({ roots = [], recent = [] }) {
  const seen = new Map();
  const add = (p, why) => {
    const abs = path.resolve(p);
    if (seen.has(abs) || !isDir(abs)) return;
    seen.set(abs, { name: path.basename(abs) || abs, path: abs, git: hasGit(abs), why });
  };
  for (const r of recent) add(r, '最近');
  for (const root of roots.slice(0, 10)) {
    add(root, 'ルート');
    let level1 = [];
    try { level1 = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && !IGNORE.has(d.name)); } catch (_) { continue; }
    for (const d of level1.slice(0, 200)) {
      const p1 = path.join(root, d.name);
      add(p1, 'ルート直下');
      if (hasGit(p1)) continue;
      let level2 = [];
      try { level2 = fs.readdirSync(p1, { withFileTypes: true }).filter((x) => x.isDirectory() && !x.name.startsWith('.') && !IGNORE.has(x.name)); } catch (_) { continue; }
      for (const x of level2.slice(0, 50)) { const p2 = path.join(p1, x.name); if (hasGit(p2)) add(p2, 'リポジトリ'); }
    }
    if (seen.size > 150) break;
  }
  return [...seen.values()].slice(0, 150);
}

// 規則で決める(Claude を使えないとき)
function heuristic(text, cands, fallbackCwd) {
  const low = text.toLowerCase();
  const hit = cands.filter((c) => c.name.length >= 2 && low.includes(c.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0];
  const cwd = hit ? hit.path : (cands.find((c) => c.why === '最近') || {}).path || fallbackCwd;
  const mode = JOB_HINTS.test(text) && !/一緒に|相談|対話/.test(text) ? 'job' : 'session';
  const edits = EDIT_HINTS.test(text);
  return {
    mode,
    cwd,
    name: text.replace(/\s+/g, ' ').slice(0, 30),
    prompt: text,
    worktree: mode === 'job' && edits && hasGit(cwd || ''),
    permissionMode: mode === 'job' ? (edits ? 'acceptEdits' : 'plan') : '',
    model: '',
    reason: hit ? `依頼文にフォルダ名「${hit.name}」が含まれていたため` : 'フォルダ名が見つからないため、最近使ったフォルダにしました',
    router: 'heuristic',
  };
}

function routerPrompt(text, cands) {
  return [
    'あなたは Claude Galaxy のディスパッチャーです。ユーザーの依頼を、どのフォルダで・どの方法で実行するかを決めます。作業そのものはしないでください。',
    '',
    '## 候補フォルダ(name: path [git] (理由))',
    ...cands.map((c) => `- ${c.name}: ${c.path}${c.git ? ' [git]' : ''} (${c.why})`),
    '',
    '## 決めること',
    '- mode: "session"(対話セッション。人とやり取りしながら進める作業、方針がまだ曖昧な作業)か "job"(ヘッドレス実行。調査・レビュー・テスト実行・定型作業など、結果だけ見ればよい作業)',
    '- cwd: 候補フォルダの path から 1 つ(依頼に合うものがなければ、最近使ったフォルダ)',
    '- worktree: ファイルを変更する作業で、cwd が git リポジトリなら true(ほかの作業と並行しても衝突しないよう、別ブランチの作業コピーで動かす)',
    '- permissionMode: job のときだけ。読むだけなら "plan"、ファイル編集が要るなら "acceptEdits"、それ以外は ""',
    '- model: 特に指定がなければ ""',
    '- name: 30 文字以内の短い名前',
    '- prompt: 実行するエージェントへの指示(依頼を、そのまま実行できる具体的な文章に整えたもの)',
    '- reason: そう決めた理由を 1 文で',
    '',
    '次の形の JSON だけを出力してください(説明やコードブロックは不要):',
    '{"mode":"job","cwd":"...","worktree":false,"permissionMode":"plan","model":"","name":"...","prompt":"...","reason":"..."}',
    '',
    '## ユーザーの依頼',
    text,
  ].join('\n');
}

function parsePlan(raw) {
  if (!raw) return null;
  const m = /\{[\s\S]*\}/.exec(String(raw));
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

// 実行案を作る。deps.ask(prompt) -> Promise<string>(Claude の答え。使えなければ reject)
async function plan(text, { roots, recent, fallbackCwd, ask }) {
  const req = String(text || '').trim().slice(0, 4000);
  if (!req) throw new Error('やりたいことを入力してください');
  const cands = candidates({ roots, recent });
  const base = heuristic(req, cands, fallbackCwd);
  if (!ask) return { ...base, candidates: cands };
  let p = null;
  let note = '';
  try { p = parsePlan(await ask(routerPrompt(req, cands))); } catch (e) { note = e.message; }
  if (!p) return { ...base, candidates: cands, note: note ? `Claude で振り分けられなかったため、簡単な規則で決めました(${note})` : 'Claude の答えが読めなかったため、簡単な規則で決めました' };
  const cwd = typeof p.cwd === 'string' && isDir(p.cwd) ? path.resolve(p.cwd) : base.cwd;
  const mode = p.mode === 'job' ? 'job' : 'session';
  return {
    mode,
    cwd,
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 60) : base.name,
    prompt: typeof p.prompt === 'string' && p.prompt.trim() ? p.prompt.trim() : req,
    worktree: !!p.worktree && hasGit(cwd),
    permissionMode: mode === 'job' && ['plan', 'acceptEdits', 'dontAsk', ''].includes(p.permissionMode) ? p.permissionMode : '',
    model: typeof p.model === 'string' && /^[A-Za-z0-9._-]{0,40}$/.test(p.model) ? p.model : '',
    reason: typeof p.reason === 'string' ? p.reason.slice(0, 300) : '',
    router: 'claude',
    candidates: cands,
  };
}

module.exports = { plan, candidates, heuristic, parsePlan };
