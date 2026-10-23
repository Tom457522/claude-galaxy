'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { injectSettings, isClaudeCommand, stripResumeFlags } = require('../cmdline');

const S = '/tmp/hooks.json';

test('claude の対話起動にだけ --settings を差し込む', () => {
  assert.strictEqual(injectSettings('claude --model opus', { settingsFile: S }).cmd, `claude --settings "${S}" --model opus`);
  assert.strictEqual(injectSettings('"C:\\Users\\me\\.local\\bin\\claude.exe"', { settingsFile: S }).injected, true);
  assert.strictEqual(injectSettings('bash', { settingsFile: S }).injected, false);
  assert.strictEqual(injectSettings('claude update', { settingsFile: S }).injected, false); // サブコマンド
  assert.strictEqual(injectSettings('claude --settings x.json', { settingsFile: S }).injected, false); // 利用者が指定済み
  assert.ok(isClaudeCommand('claude'));
  assert.ok(!isClaudeCommand('wsl claude'));
});

test('--mcp-config は直後に --settings を置いて区切る', () => {
  const r = injectSettings('claude "hello"', { settingsFile: S, mcp: 'C:\\tmp\\mcp.json' });
  assert.strictEqual(r.cmd, `claude --mcp-config "C:/tmp/mcp.json" --settings "${S}" "hello"`);
});

test('再開時は利用者の --resume / --continue を外して ID を付ける', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  const r = injectSettings('claude -c --model x --resume abc', { settingsFile: S, resumeId: id });
  assert.ok(r.resumed);
  assert.match(r.cmd, new RegExp(`--resume ${id}`));
  assert.doesNotMatch(r.cmd, /-c |--resume abc/);
  // ID として不正な値は付けない
  assert.strictEqual(injectSettings('claude', { settingsFile: S, resumeId: 'x; rm -rf /' }).resumed, false);
});

test('stripResumeFlags', () => {
  assert.strictEqual(stripResumeFlags(' -r abc --model x').trim(), '--model x');
  assert.strictEqual(stripResumeFlags(' --resume=abc').trim(), '');
  assert.strictEqual(stripResumeFlags(' --continue --verbose').trim(), '--verbose');
  assert.strictEqual(stripResumeFlags(' --resume --verbose').trim(), '--verbose');
});
