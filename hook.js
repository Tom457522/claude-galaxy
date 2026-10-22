#!/usr/bin/env node
'use strict';
// Claude Code の hook から呼ばれ、イベントを Claude Multi Term サーバーへ中継する。
// - stdout には何も出さない(UserPromptSubmit 等では stdout が Claude の文脈に入るため)
// - 失敗しても常に exit 0(Claude Code の動作を邪魔しない)
// - 送るのは状態表示に必要な最小限の項目だけ(ファイル内容やコマンド本文は送らない)

const http = require('http');

const sid = process.env.MULTI_TERM_SESSION;
const port = process.env.MULTI_TERM_PORT;
const token = process.env.MULTI_TERM_TOKEN;
if (!sid || !port || !token) process.exit(0);

let sent = false;
let raw = '';

const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);

function slim(p) {
  const out = {
    hook_event_name: p.hook_event_name || process.argv[2],
    agent_id: p.agent_id,
    agent_type: p.agent_type,
    tool_name: p.tool_name,
    notification_type: p.notification_type || p.type,
    message: clip(p.message, 200),
    source: p.source,
    reason: p.reason,
    error: clip(typeof p.error === 'string' ? p.error : p.error_type, 120),
    last_assistant_message: clip(p.last_assistant_message, 300),
  };
  // サブエージェント起動(Task / Agent ツール)の説明文だけ拾う
  const ti = p.tool_input;
  if (ti && typeof ti === 'object' && (p.tool_name === 'Task' || p.tool_name === 'Agent')) {
    out.task = { description: clip(ti.description, 120), subagent_type: clip(ti.subagent_type, 60) };
  }
  return out;
}

function send(payload) {
  if (sent) return;
  sent = true;
  const body = JSON.stringify({ sessionId: sid, payload: slim(payload) });
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: '/api/hook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Multi-Term-Token': token,
      },
      timeout: 1500,
    },
    (res) => { res.resume(); res.on('end', () => process.exit(0)); }
  );
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(body);
}

const guard = setTimeout(() => send({}), 1500);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  clearTimeout(guard);
  let p = {};
  try { p = JSON.parse(raw); } catch (_) { /* ignore */ }
  send(p);
});
process.stdin.on('error', () => { clearTimeout(guard); send({}); });
