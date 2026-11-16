'use strict';
// 共有メモリの書き出し: 確認済みの項目を、Obsidian の Vault(SecondBrain など)のフォルダに 1 項目 1 ノートで書き出す。
//   クラウドのスケジュールタスクやスマホからも、確かめた知識を読めるようにするため(一方向。Vault 側で直しても戻らない)
//   書き出すのは「確認済み」かつ期限内の項目だけ。秘密らしい文字列を含む項目は書き出さない
//   書き出し先: <Vault>/03_Areas/エージェントの知識/項目/。Galaxy が書いたノート(source: claude-galaxy)だけを書き換え・削除する
//   mode: 'off' / 'files'(ファイルを書くだけ)/ 'push'(そのフォルダだけをコミットして push)

const fs = require('fs');
const path = require('path');

const SUBDIR = path.join('03_Areas', 'エージェントの知識', '項目');
const MARK = 'source: claude-galaxy';
const MAX_NAME = 100;

// 秘密らしい文字列(見つけたら書き出さない。誤検知はあってよい)
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '秘密鍵'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/, 'API キー(sk-)'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/, 'GitHub のトークン'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS のアクセスキー'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'Slack のトークン'],
  [/\bAIza[0-9A-Za-z_-]{30,}/, 'Google の API キー'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i, 'パスワード・トークンの値'],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/, '認証ヘッダーの値'],
  [/[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, 'URL の中の資格情報'],
  [/^[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S{6,}/m, '環境変数の秘密の値'],
];
function secretReason(text) {
  for (const [re, label] of SECRET_PATTERNS) if (re.test(text)) return label;
  return '';
}

// キーからファイル名を作る(SecondBrain の決まり: / \ : * ? " < > | # ^ [ ] は全角にする)
const FULL = { '/': '／', '\\': '＼', ':': '：', '*': '＊', '?': '？', '"': '”', '<': '＜', '>': '＞', '|': '｜', '#': '＃', '^': '＾', '[': '［', ']': '］' };
function fileName(key) {
  let n = String(key).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/[/\\:*?"<>|#^[\]]/g, (c) => FULL[c]).trim();
  n = n.replace(/^\.+/, (d) => '．'.repeat(d.length)).slice(0, MAX_NAME).trim().replace(/\.+$/, (d) => '．'.repeat(d.length));
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(n)) n = `_${n}`; // Windows の予約名
  return n || '名前なし';
}

const ymd = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// Obsidian のタグに使えない文字を除く
const tagOf = (t) => String(t).replace(/[\s#,[\]{}"'`]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function buildNote(m) {
  const tags = ['agent-memory', ...(m.priority === 'must' ? ['必須'] : []), ...(m.tags || []).map(tagOf).filter(Boolean)];
  const fm = [
    '---',
    'type: agent-memory',
    `key: ${JSON.stringify(m.key)}`,
    `priority: ${m.priority === 'must' ? 'must' : 'normal'}`,
    'verified: true',
    ...(m.expires ? [`expires: ${m.expires}`] : []),
    `updated: ${ymd(m.updatedAt || Date.now())}`,
    `author: ${JSON.stringify(String(m.author || ''))}`,
    `tags: ${JSON.stringify([...new Set(tags)])}`,
    MARK,
    '---',
  ];
  return `${fm.join('\n')}\n\n# ${String(m.key).replace(/[\r\n]+/g, ' ')}\n\n` +
    '<!-- Claude Galaxy が共有メモリから書き出したノート。ここを直しても次の書き出しで上書きされる。直すときは Galaxy のボードで -->\n\n' +
    `${String(m.value).replace(/\r\n/g, '\n').trimEnd()}\n`;
}

// Galaxy が書いたノートか(フロントマターの中に印があるか)。本文に同じ行があるだけのノートは対象にしない
function hasMark(text) {
  const lines = String(text).split('\n');
  if (lines[0] !== '---') return false;
  for (let i = 1; i < lines.length && i < 60; i++) {
    if (lines[i] === '---') return false;
    if (lines[i] === MARK) return true;
  }
  return false;
}
const isOurs = (file) => {
  try { return !fs.lstatSync(file).isSymbolicLink() && hasMark(fs.readFileSync(file, 'utf8').slice(0, 4000)); } catch (_) { return false; }
};

// entries を dir(Vault のルート)に書き出す。変わらないファイルは書かない
function exportTo(vault, entries, { now = Date.now() } = {}) {
  const dir = path.join(vault, SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  // 途中のフォルダがシンボリックリンクで Vault の外を指していたら書かない
  const realVault = fs.realpathSync(vault);
  if (path.relative(realVault, fs.realpathSync(dir)).startsWith('..')) throw new Error(`書き出し先が Vault の外を指しています: ${dir}`);
  const today = ymd(now);
  const result = { dir, written: [], unchanged: 0, removed: [], blocked: [], exported: 0 };
  const wanted = new Map(); // ファイル名 -> 内容
  const taken = new Set();
  for (const m of entries) {
    if (!m.verified || (m.expires && m.expires < today)) continue;
    const why = secretReason(`${m.key}\n${m.value}\n${(m.tags || []).join(' ')}\n${m.author || ''}`);
    if (why) { result.blocked.push({ key: m.key, reason: why }); continue; }
    // macOS / Windows は大文字小文字を区別しないので、区別せずに重複を避ける
    let name = fileName(m.key);
    for (let i = 2; taken.has(`${name}.md`.toLowerCase()); i++) name = `${fileName(m.key)} (${i})`;
    taken.add(`${name}.md`.toLowerCase());
    wanted.set(`${name}.md`, buildNote(m));
  }
  for (const [name, body] of wanted) {
    const file = path.join(dir, name);
    let cur = null;
    try {
      if (fs.lstatSync(file).isSymbolicLink()) { result.blocked.push({ key: name, reason: 'シンボリックリンクなので書きません' }); continue; }
      cur = fs.readFileSync(file, 'utf8');
    } catch (_) { /* 新規 */ }
    if (cur === body) { result.unchanged++; continue; }
    if (cur !== null && !hasMark(cur)) { result.blocked.push({ key: name, reason: '同じ名前の、Galaxy が書いていないノートがあります' }); continue; }
    fs.writeFileSync(file, body);
    result.written.push(name);
  }
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md') || wanted.has(name)) continue;
    const file = path.join(dir, name);
    if (isOurs(file)) { fs.unlinkSync(file); result.removed.push(name); }
  }
  result.exported = result.written.length + result.unchanged;
  return result;
}

module.exports = { exportTo, buildNote, fileName, secretReason, hasMark, SUBDIR, MARK };
