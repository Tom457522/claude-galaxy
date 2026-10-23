'use strict';
// 起動コマンドの組み立て(claude の対話起動に --settings / --mcp-config / --resume を差し込む)

const path = require('path');

const CLAUDE_SUBCOMMANDS = new Set([
  'update', 'install', 'doctor', 'mcp', 'plugin', 'plugins', 'auth', 'agents', 'attach', 'logs',
  'rm', 'stop', 'kill', 'respawn', 'daemon', 'remote-control', 'setup-token', 'purge', 'import',
  'gateway', 'ultrareview', 'auto-mode', 'self-hosted-runner',
]);

const SAFE_ID = /^[A-Za-z0-9_-]{8,100}$/;
const fwd = (p) => p.replace(/\\/g, '/'); // bash / PowerShell / cmd のどれでも通るよう / 区切りにする

// 利用者が書いた --resume / --continue を外す(再開時はこちらで ID を指定するため)
function stripResumeFlags(rest) {
  return rest
    .replace(/(^|\s)(--continue|-c)(?=\s|$)/g, '$1')
    .replace(/(^|\s)(--resume|-r)(=|\s+)(?!-)("[^"]*"|\S+)/g, '$1')
    .replace(/(^|\s)(--resume|-r)(?=\s|$)/g, '$1');
}

// 起動コマンドが claude の対話起動なら、先頭語の直後に --settings を差し込む
//   resumeId を渡すと、--resume <id> も付ける(会話の再開)。mcp を渡すと --mcp-config も付ける
function injectSettings(cmdline, { settingsFile, resumeId, mcp, extra = '' } = {}) {
  const m = /^("[^"]+"|\S+)([\s\S]*)$/.exec(String(cmdline || '').trim());
  if (!m) return { cmd: cmdline, injected: false };
  const first = m[1].replace(/^"|"$/g, '');
  const base = path.basename(first.replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  if (base !== 'claude') return { cmd: cmdline, injected: false };
  let rest = m[2];
  if (/(^|\s)--settings(\s|=)/.test(rest)) return { cmd: cmdline, injected: false }; // 利用者が自分で指定済み
  const next = rest.trim().split(/\s+/)[0];
  if (next && CLAUDE_SUBCOMMANDS.has(next)) return { cmd: cmdline, injected: false };
  let resume = '';
  if (resumeId && SAFE_ID.test(resumeId)) {
    rest = stripResumeFlags(rest);
    resume = ` --resume ${resumeId}`;
  }
  // --mcp-config は複数の値を取るので、直後に --settings を置いて区切る
  const mcpArg = mcp ? ` --mcp-config "${fwd(mcp)}"` : '';
  // extra: こちらで足す引数(値は呼び出し側でクォート済みのもの)
  return { cmd: `${m[1]}${mcpArg} --settings "${fwd(settingsFile || '')}"${resume}${extra ? ` ${extra}` : ''}${rest}`, injected: true, resumed: !!resume };
}

const isClaudeCommand = (cmdline) => injectSettings(cmdline).injected;

module.exports = { injectSettings, isClaudeCommand, stripResumeFlags, SAFE_ID, fwd };
