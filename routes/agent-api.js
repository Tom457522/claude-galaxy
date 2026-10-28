'use strict';
// エージェント(hook.js / mcp-bus.js)からの API と、画面への状態配信(SSE)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { matchApproval, parseSafetyEvents, describeSafetyEvent } = require('../safety');

module.exports = function routes(ctx) {
  const {
    onDiagHook,
    app, wrap, sessions, settings, jobs, automations, bus, audit, tools, gitx, store, appsStore, dispatch,
    permissions, permInfo, resolvePermission, cancelPermissions, nextPermId,
    createSession, restartSession, publicInfo, emit, persist, setStatus, applyHook, trackTranscript,
    removeMcpConfig, cleanupWorktree, broadcast, sseClients, resolveCwd, isClaudeCommand, assertCommandExists,
    agentName, agentList, resolveAgent, typeInto, busCall, hookAuth, runClaude, buildGraph,
    claudeMcpServers, claudeExtensions, targetOf,
    DEFAULT_COMMAND, JOB_COMMAND, SHELL, IS_WIN, PERMISSION_WAIT, APPS_PORT, ROOT_DIR
  } = ctx;

  // hook.js からのイベント受信(トークン必須)
  app.post('/api/hook', (req, res) => {
    const agent = hookAuth(req); // トークンから決めたエージェント(本文の sessionId は使わない)
    if (!agent) return res.status(401).end();
    if (agent === 'diag') { onDiagHook(); return res.status(204).end(); }
    const s = sessions.get(agent);
    if (s && s.alive && req.body.payload && typeof req.body.payload === 'object') {
      applyHook(s, req.body.payload);
    }
    res.status(204).end();
  });

  // mcp-bus.js からのツール呼び出し(トークン必須。from は起動時に渡したエージェント ID)
  app.post('/api/bus', async (req, res) => {
    const from = hookAuth(req); // 呼び出し元はトークンで決める(本文の from は使わない)
    if (!from) return res.status(401).end();
    const b = req.body || {};
    try {
      const result = await busCall(from, String(b.tool || ''), b.args && typeof b.args === 'object' ? b.args : {});
      res.json({ result });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // hook.js からの権限確認。受信箱で決まるまで応答を保留する(long poll)
  app.post('/api/permission', (req, res) => {
    const agentId = hookAuth(req);
    if (!agentId) return res.status(401).end();
    const s = sessions.get(agentId);
    const isJob = !s && jobs.isRunning(agentId); // ジョブ(claude -p)の確認も受信箱へ。答えがなければ拒否になる
    const p = req.body?.payload;
    if ((!isJob && (!s || !s.alive)) || !p || typeof p !== 'object' || !settings.permissionInbox) {
      return res.json({ behavior: 'ask' });
    }
    if (s) trackTranscript(s, p);
    queuePermission(agentId, s, p, res, { behavior: 'ask' });
  });

  // 受信箱に積んで、決まるまで res を保留する。時間切れのときは onTimeout を返す
  function queuePermission(agentId, s, p, res, onTimeout, extra = {}) {
    const id = nextPermId();
    const now = Date.now();
    const x = {
      id,
      sessionId: agentId,
      at: now,
      expiresAt: now + PERMISSION_WAIT * 1000,
      tool: typeof p.tool_name === 'string' ? p.tool_name : '?',
      mcpServer: typeof p.mcp_server === 'string' ? p.mcp_server : '',
      agentId: p.agent_id || null,
      agentType: typeof p.agent_type === 'string' ? p.agent_type : '',
      input: p.input && typeof p.input === 'object' ? p.input : {},
      suggestions: Array.isArray(p.permission_suggestions) ? p.permission_suggestions.filter((u) => u && typeof u === 'object') : [],
      res,
      timer: null,
      ...extra,
    };
    x.timer = setTimeout(() => resolvePermission(id, onTimeout, 'timeout'), PERMISSION_WAIT * 1000);
    // hook 側が先に終わった(Claude 側で中断された等)ら片付ける
    res.on('close', () => { if (permissions.has(id)) resolvePermission(id, { behavior: 'ask' }); });
    permissions.set(id, x);
    broadcast('permission', permInfo(x));
    if (s) {
      setStatus(s, 'waiting', `${x.tool} の許可待ち`);
      emit(s);
    }
  }

  // hook.js(PreToolUseGate)からの承認ゲート。危ないコマンドだけ受信箱で承認を待つ。
  // 許可済みのツールでも呼ばれるので、無人のジョブの強制 push・公開・外部送信もここで止まる。
  // 承認されなかったとき(拒否・時間切れ・受信箱オフ・中断)は必ず拒否にする
  app.post('/api/gate', (req, res) => {
    const agentId = hookAuth(req);
    if (!agentId) return res.status(401).end();
    const p = req.body?.payload;
    if (!settings.approvalGate || !p || typeof p !== 'object') return res.json({});
    const command = typeof p.input?.command === 'string' ? p.input.command : '';
    const pattern = matchApproval(command, settings.approvalPatterns);
    if (!pattern) return res.json({});
    const s = sessions.get(agentId);
    const isJob = !s && jobs.isRunning(agentId);
    audit.log({ agent: agentId, agentName: agentName(agentId), kind: 'safety', tool: p.tool_name || 'Bash', target: command.slice(0, 300), detail: `承認ゲート: ${pattern}` });
    if ((!isJob && (!s || !s.alive)) || !settings.permissionInbox) {
      return res.json({ decision: 'deny', reason: '承認ゲート: 受信箱がオフのため、この操作は実行できません(Claude Galaxy の設定)' });
    }
    // resolvePermission は { behavior } を返すので、PreToolUse の形に直して返す
    const shim = {
      get writableEnded() { return res.writableEnded; },
      on: (...a) => res.on(...a),
      json(d) {
        if (d.behavior === 'allow') return res.json({ decision: 'allow' });
        return res.json({ decision: 'deny', reason: d.message || '承認ゲート: 受信箱で承認されなかったため実行しません' });
      },
    };
    queuePermission(agentId, s, { ...p, permission_suggestions: [] }, shim,
      { behavior: 'deny', message: '承認ゲート: 承認の待ち時間を過ぎたため実行しません' },
      { gate: pattern });
  });

  // 子の claude の OpenTelemetry(OTLP/HTTP JSON のログ)。safety_event だけを監査ログに残す
  app.post('/otel/v1/logs', (req, res) => {
    const agentId = hookAuth(req);
    if (!agentId) return res.status(401).end();
    if (settings.collectSafetyEvents) {
      for (const e of parseSafetyEvents(req.body).slice(0, 100)) {
        audit.log({ agent: agentId, agentName: agentName(agentId), kind: 'safety', ...describeSafetyEvent(e) });
      }
    }
    res.json({});
  });

  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });
};
