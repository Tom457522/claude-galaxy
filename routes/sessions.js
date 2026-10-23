'use strict';
// セッション・権限確認(受信箱)・設定の API

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

  // ---- REST API ----
  app.get('/api/sessions', (_req, res) => {
    res.json([...sessions.values()].map(publicInfo));
  });

  app.post('/api/sessions', (req, res) => {
    try {
      const { name, cwd, command, appId, worktree, mcpServers, memory } = req.body || {};
      const s = createSession({ name, cwd, command, appId, worktree: !!worktree, mcpServers, memory });
      res.status(201).json(publicInfo(s));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.patch('/api/sessions/:id', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    if (typeof req.body?.name === 'string' && req.body.name.trim()) s.name = req.body.name.trim();
    emit(s);
    res.json(publicInfo(s));
  });

  app.delete('/api/sessions/:id', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    clearTimeout(s.doneTimer);
    clearTimeout(s.actTimer);
    clearTimeout(s.usageTimer);
    cancelPermissions(s.id);
    const proc = s.proc;
    s.proc = null; // onExit を無視させる
    s.alive = false;
    if (proc) {
      try { proc.kill(); } catch (_) { /* ignore */ }
    }
    for (const ws of s.clients) ws.close();
    sessions.delete(s.id);
    store.removeLog(s.id);
    removeMcpConfig(s.id);
    // プロセスが終わってから片付ける(使用中のフォルダは消せないことがあるため)
    if (s.worktree && !s.worktree.removed) setTimeout(() => cleanupWorktree(s.id, s.name, s.worktree), 1500);
    persist();
    broadcast('removed', { id: s.id });
    res.status(204).end();
  });

  app.post('/api/sessions/:id/restart', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    try {
      restartSession(s, { resume: !!req.body?.resume });
      res.json(publicInfo(s));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/permissions', (_req, res) => res.json([...permissions.values()].map(permInfo)));

  app.post('/api/permissions/:id', (req, res) => {
    const x = permissions.get(req.params.id);
    if (!x) return res.status(404).json({ error: 'この確認はもう終わっています' });
    const b = req.body || {};
    let decision;
    if (b.behavior === 'allow') {
      decision = { behavior: 'allow' };
      if (b.always) {
        const updates = x.suggestions.filter((u) => u.type === 'addRules' && u.behavior === 'allow');
        if (updates.length) decision.updatedPermissions = updates;
      }
    } else if (b.behavior === 'deny') {
      decision = { behavior: 'deny', message: typeof b.message === 'string' ? b.message.slice(0, 500) : '', interrupt: !!b.interrupt };
    } else {
      decision = { behavior: 'ask' }; // ターミナルの確認ダイアログで答える
    }
    resolvePermission(x.id, decision, 'user');
    res.status(204).end();
  });

  app.get('/api/settings', (_req, res) => res.json(settings));
  app.put('/api/settings', (req, res) => {
    const b = req.body || {};
    if (typeof b.permissionInbox === 'boolean') settings.permissionInbox = b.permissionInbox;
    if (typeof b.busEnabled === 'boolean') settings.busEnabled = b.busEnabled;
    if (Number.isFinite(b.maxConcurrentJobs)) settings.maxConcurrentJobs = Math.min(10, Math.max(1, Math.round(b.maxConcurrentJobs)));
    if (typeof b.auditEnabled === 'boolean') settings.auditEnabled = b.auditEnabled;
    if (Number.isFinite(b.auditDays)) settings.auditDays = Math.min(365, Math.max(1, Math.round(b.auditDays)));
    if (typeof b.worktreeDir === 'string') {
      try { settings.worktreeDir = b.worktreeDir.trim() ? resolveCwd(b.worktreeDir) : ''; } catch (e) { return res.status(400).json({ error: e.message }); }
    }
    for (const k of ['budgetDailyUsd', 'budgetJobUsd', 'budgetSessionWarnUsd', 'planMonthlyUsd']) {
      if (b[k] !== undefined) settings[k] = Math.max(0, Math.min(100000, Number(b[k]) || 0));
    }
    for (const k of ['planLimitSessionPct', 'planLimitWeeklyPct', 'planPaceMargin']) {
      if (b[k] !== undefined) settings[k] = Math.max(0, Math.min(100, Math.round(Number(b[k]) || 0)));
    }
    if (typeof b.planPaceGuard === 'boolean') settings.planPaceGuard = b.planPaceGuard;
    if (typeof b.budgetIncludeCloud === 'boolean') settings.budgetIncludeCloud = b.budgetIncludeCloud;
    if (typeof b.notifyDesktop === 'boolean') settings.notifyDesktop = b.notifyDesktop;
    if (typeof b.dispatchModel === 'string' && /^[A-Za-z0-9._-]{0,40}$/.test(b.dispatchModel.trim())) settings.dispatchModel = b.dispatchModel.trim();
    jobs.pump();
    ctx.budget.check();
    ctx.plan.check(); // しきい値が変わったら待ちのジョブを動かす / 止める
    for (const x of sessions.values()) emit(x); // セッションの警告額の表示を更新
    try { store.saveSettings(settings); } catch (e) { return res.status(500).json({ error: e.message }); }
    if (!settings.permissionInbox) for (const x of [...permissions.values()]) resolvePermission(x.id, { behavior: 'ask' });
    broadcast('settings', settings);
    res.json(settings);
  });
};
