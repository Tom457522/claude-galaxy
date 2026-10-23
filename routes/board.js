'use strict';
// ボード(メッセージと共有メモリ)の API

const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = function routes(ctx) {
  const {
    app, wrap, sessions, settings, jobs, automations, bus, audit, tools, gitx, store, appsStore, dispatch,
    permissions, permInfo, resolvePermission, cancelPermissions, nextPermId,
    createSession, restartSession, publicInfo, emit, persist, setStatus, applyHook, trackTranscript,
    removeMcpConfig, cleanupWorktree, broadcast, sseClients, resolveCwd, isClaudeCommand, assertCommandExists,
    agentName, agentList, resolveAgent, typeInto, busCall, hookAuth, runClaude, buildGraph,
    claudeMcpServers, claudeExtensions, targetOf,
    DEFAULT_COMMAND, JOB_COMMAND, SHELL, IS_WIN, PERMISSION_WAIT, APPS_PORT, ROOT_DIR
  } = ctx;

  // ---- ボード(メッセージと共有メモリを人が見る・書く)----
  app.get('/api/board', wrap(() => ({
    messages: bus.messages(),
    memory: bus.memSearch('', { limit: 2000 }),
    unreadUser: bus.unreadCount('user'),
    agents: agentList(),
  })));
  app.post('/api/board/messages', wrap((req) => {
    const b = req.body || {};
    const to = resolveAgent(b.to, 'user');
    const m = bus.send({ from: 'user', fromName: 'あなた', to, toName: agentName(to), text: b.text });
    // 待機中の対話セッション宛てなら、そのままプロンプトとして入力することもできる
    if (b.asPrompt) {
      const s = sessions.get(to);
      if (!s || !s.alive) throw new Error('プロンプトとして送れるのは実行中の対話セッションだけです');
      typeInto(s, b.text);
      bus.inbox(to, { unreadOnly: true });
    }
    return m;
  }));
  app.post('/api/board/read', wrap(() => { bus.inbox('user', { unreadOnly: true }); }));
  app.delete('/api/board/messages', wrap(() => { bus.clearMessages(); }));
  app.put('/api/board/memory', wrap((req) => {
    const b = req.body || {};
    return bus.memWrite(b.key, b.value, { tags: b.tags, author: 'あなた' });
  }));
  app.delete('/api/board/memory', wrap((req) => { if (!bus.memDelete(String(req.query.key || ''))) throw new Error('見つかりません'); }));
};
