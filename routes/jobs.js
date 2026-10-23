'use strict';
// ジョブとオートメーションの API

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

  // ---- ジョブ ----

  app.get('/api/jobs', wrap(() => ({ jobs: jobs.list(), maxConcurrent: settings.maxConcurrentJobs, command: JOB_COMMAND })));
  app.post('/api/jobs', wrap((req) => jobs.create(req.body || {}, { source: 'ui' })));
  app.post('/api/jobs/:id/cancel', wrap((req) => { jobs.cancel(req.params.id); }));
  app.post('/api/jobs/:id/retry', wrap((req) => jobs.retry(req.params.id)));
  app.delete('/api/jobs/:id', wrap((req) => {
    const j = jobs.get(req.params.id);
    if (!j || !jobs.remove(req.params.id)) throw new Error('見つかりません');
    if (j.worktreeInfo && !j.worktreeInfo.removed) setTimeout(() => cleanupWorktree(j.id, j.name, j.worktreeInfo), 1500);
  }));
  app.get('/api/jobs/:id/transcript', wrap((req) => jobs.transcript(req.params.id)));
  // ジョブの会話を、対話セッションとして開く(claude --resume)
  app.post('/api/jobs/:id/open', wrap((req) => {
    const j = jobs.get(req.params.id);
    if (!j) throw new Error('見つかりません');
    if (!j.claudeSessionId) throw new Error('このジョブには Claude のセッション ID がありません');
    if (j.status === 'running') throw new Error('実行中のジョブは開けません(終わってから開いてください)');
    const cmd = isClaudeCommand(DEFAULT_COMMAND) ? DEFAULT_COMMAND : JOB_COMMAND;
    return publicInfo(createSession({ name: `${j.name} (${j.id})`, cwd: j.cwd, command: cmd, resumeId: j.claudeSessionId }));
  }));

  // ---- オートメーション ----
  app.get('/api/automations', wrap(() => automations.list()));
  app.post('/api/automations', wrap((req) => automations.create(req.body || {})));
  app.put('/api/automations/:id', wrap((req) => {
    const a = automations.update(req.params.id, req.body || {});
    if (!a) throw new Error('見つかりません');
    return a;
  }));
  app.delete('/api/automations/:id', wrap((req) => { if (!automations.remove(req.params.id)) throw new Error('見つかりません'); }));
  app.post('/api/automations/:id/run', wrap((req) => automations.run(req.params.id)));
};
