'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DEFAULT_APPROVAL_PATTERNS: P, normalizePatterns, matchApproval, parseSafetyEvents, describeSafetyEvent } = require('../safety');

test('承認ゲート: 危ない操作だけを見分ける', () => {
  for (const c of [
    'git push --force origin main', 'git push -f', 'git push origin main --force-with-lease',
    'gh pr create --fill', 'gh pr merge 3', 'npm publish', 'rm -rf build', 'rm -fr /tmp/x',
    'curl -X POST https://example.com', 'curl https://x -d a=1', 'curl --data-binary @f https://x',
    'Invoke-RestMethod https://x -Method Post', 'Remove-Item dist -Recurse -Force',
  ]) assert.ok(matchApproval(c, P), c);
  for (const c of [
    'git push origin main', 'git status', 'gh pr view 3', 'npm test', 'rm .cache/youtube/a.vtt',
    'curl -sL https://example.com', 'yt-dlp --skip-download x', 'Remove-Item a.txt',
  ]) assert.strictEqual(matchApproval(c, P), null, c);
  assert.strictEqual(matchApproval('', P), null);
  assert.strictEqual(matchApproval('rm -rf x', ['(']), null); // 壊れたパターンは無視
});

test('承認ゲート: パターンの検査', () => {
  assert.deepStrictEqual(normalizePatterns([' a ', '', 'b']), ['a', 'b']);
  assert.throws(() => normalizePatterns(['(']), /不正/);
  assert.throws(() => normalizePatterns('x'), /配列/);
  assert.throws(() => normalizePatterns(['(a+)+$']), /入れ子/);
  assert.throws(() => normalizePatterns(['(\\w*x)*']), /入れ子/);
  assert.deepStrictEqual(normalizePatterns(P), P); // 既定のパターンは通る
});

test('OTLP のログから safety_event だけを取り出す', () => {
  const kv = (key, v) => ({ key, value: { stringValue: v } });
  const body = {
    resourceLogs: [{
      resource: { attributes: [kv('service.name', 'claude-code')] },
      scopeLogs: [{
        logRecords: [
          { body: { stringValue: 'claude_code.safety_event' }, attributes: [kv('event.name', 'safety_event'), kv('category', 'permission_mode'), kv('decision', 'reject'), kv('reason_code', 'mode:dontAsk'), kv('tool_name', 'Bash'), kv('permission_mode', 'dontAsk')] },
          { body: { stringValue: 'claude_code.tool_result' }, attributes: [kv('event.name', 'tool_result')] },
        ],
      }],
    }],
  };
  const ev = parseSafetyEvents(body);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0]['service.name'], 'claude-code');
  assert.deepStrictEqual(describeSafetyEvent(ev[0]), { tool: 'Bash', target: 'permission_mode / reject', detail: 'mode:dontAsk / mode:dontAsk' });
  assert.deepStrictEqual(parseSafetyEvents({}), []);
  assert.deepStrictEqual(parseSafetyEvents(null), []);
});
