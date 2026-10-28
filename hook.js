#!/usr/bin/env node
'use strict';
// Claude Code の hook から呼ばれ、イベントを Claude Galaxy サーバーへ中継する。
// - stdout には何も出さない(UserPromptSubmit 等では stdout が Claude の文脈に入るため)
//   例外は PermissionRequest で、アプリの受信箱で許可/拒否されたときだけ決定を JSON で返す
//   もう 1 つの例外は PreToolUseGate(承認ゲート)で、危ないコマンドについて受信箱で決まった許可/拒否を返す
// - 失敗しても常に exit 0(Claude Code の動作を邪魔しない。PermissionRequest なら通常の確認ダイアログになる)
// - 送るのは状態表示に必要な最小限の項目だけ(ファイル内容は送らない。
//   PermissionRequest だけは判断材料として、コマンド文字列やファイルパスを送る。
//   承認ゲートがオンのときは、Bash / PowerShell のコマンド文字列も一致判定のために送る)

const http = require('http');

const sid = process.env.GALAXY_SESSION;
const port = process.env.GALAXY_PORT;
const token = process.env.GALAXY_TOKEN;
if (!sid || !port || !token) process.exit(0);

const EVENT = process.argv[2] || '';
let sent = false;
let raw = '';

const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);

function slim(p) {
  const out = {
    hook_event_name: p.hook_event_name || EVENT,
    session_id: clip(p.session_id, 100),
    transcript_path: clip(p.transcript_path, 1000),
    agent_transcript_path: clip(p.agent_transcript_path, 1000),
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
  // 監査ログ用: 実行したツールの対象(ファイルパス・コマンドの先頭など。中身は送らない)
  if (ti && typeof ti === 'object' && out.hook_event_name === 'PostToolUse') {
    const v = ti.command || ti.file_path || ti.notebook_path || ti.url || ti.pattern || ti.path || ti.description || '';
    out.target = clip(String(v), 300);
  }
  return out;
}

// 権限確認の判断材料(ツールごとに要点だけ)
function permissionInfo(p) {
  const ti = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  const pick = {};
  for (const k of ['command', 'description', 'file_path', 'path', 'url', 'pattern', 'prompt', 'notebook_path']) {
    if (typeof ti[k] === 'string') pick[k] = ti[k].slice(0, k === 'command' ? 4000 : 500);
  }
  if (!Object.keys(pick).length) {
    try { pick.input = JSON.stringify(ti).slice(0, 1500); } catch (_) { /* ignore */ }
  }
  return {
    ...slim(p),
    mcp_server: clip(p.mcp_server, 100),
    cwd: clip(p.cwd, 1000),
    permission_mode: clip(p.permission_mode, 40),
    input: pick,
    // 「今後も許可」用。受け取ったものをそのまま返せる(中身はルール定義だけ)
    permission_suggestions: Array.isArray(p.permission_suggestions) ? p.permission_suggestions.slice(0, 10) : [],
  };
}

function post(pathname, payload, timeoutMs, onBody) {
  const body = JSON.stringify({ sessionId: sid, payload });
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Galaxy-Token': token,
      },
      timeout: timeoutMs,
    },
    (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { if (!onBody(res.statusCode, data)) process.exit(0); });
    }
  );
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(body);
}

// 承認ゲート: Bash / PowerShell のコマンドをサーバーに見せ、危ないものなら受信箱の決定を待つ。
// 許可済みのツール(allowedTools・dontAsk)でも PreToolUse は呼ばれるので、無人のジョブにも効く
function gate(p) {
  const ti = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  if (typeof ti.command !== 'string' || !ti.command) process.exit(0);
  // 承認ゲートがオンのときだけ登録される hook。判断に要る項目だけを送る(会話の内容などは送らない)
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name: p.tool_name,
    agent_id: p.agent_id,
    agent_type: p.agent_type,
    cwd: clip(p.cwd, 1000),
    permission_mode: clip(p.permission_mode, 40),
    input: { command: ti.command.slice(0, 4000), description: clip(ti.description, 500) },
  };
  post('/api/gate', payload, 0, (status, data) => {
    if (status !== 200) return false;
    let d;
    try { d = JSON.parse(data); } catch (_) { return false; }
    if (!d || (d.decision !== 'allow' && d.decision !== 'deny' && d.decision !== 'ask')) return false; // 決定なし → 通常どおり
    const out = { hookEventName: 'PreToolUse', permissionDecision: d.decision };
    if (typeof d.reason === 'string' && d.reason) out.permissionDecisionReason = d.reason.slice(0, 500);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: out }), () => process.exit(0));
    return true;
  });
}

function send(p) {
  if (sent) return;
  sent = true;
  if (EVENT === 'PreToolUseGate') {
    gate(p);
    return;
  }
  if (EVENT !== 'PermissionRequest') {
    post('/api/hook', slim(p), 1500, () => false);
    return;
  }
  // 受信箱で決まるまで待つ(サーバー側で待ち時間の上限を管理する)
  post('/api/permission', permissionInfo(p), 0, (status, data) => {
    if (status !== 200) return false;
    let d;
    try { d = JSON.parse(data); } catch (_) { return false; }
    if (!d || (d.behavior !== 'allow' && d.behavior !== 'deny')) return false; // 'ask' → 通常のダイアログ
    const decision = { behavior: d.behavior };
    if (d.behavior === 'allow' && Array.isArray(d.updatedPermissions) && d.updatedPermissions.length) {
      decision.updatedPermissions = d.updatedPermissions;
    }
    if (d.behavior === 'deny') {
      decision.message = typeof d.message === 'string' && d.message ? d.message : 'Claude Galaxy の受信箱で拒否されました';
      decision.interrupt = !!d.interrupt;
    }
    // パイプへの書き込みが終わってから終了する(途中で exit すると出力が欠けることがある)
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }), () => process.exit(0));
    return true;
  });
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
