'use strict';
// エージェント(hook.js / mcp-bus.js)からの API と、画面への状態配信(SSE)

const fs = require('fs');
const os = require('os');
const path = require('path');

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
    };
    x.timer = setTimeout(() => resolvePermission(id, { behavior: 'ask' }, 'timeout'), PERMISSION_WAIT * 1000);
    // hook 側が先に終わった(Claude 側で中断された等)ら片付ける
    res.on('close', () => { if (permissions.has(id)) resolvePermission(id, { behavior: 'ask' }); });
    permissions.set(id, x);
    broadcast('permission', permInfo(x));
    if (s) {
      setStatus(s, 'waiting', `${x.tool} の許可待ち`);
      emit(s);
    }
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
