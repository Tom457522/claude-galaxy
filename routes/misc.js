'use strict';
// 画面の初期値・フォルダグラフ・アプリ一覧の API

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

  app.get('/api/defaults', (_req, res) => {
    // ホーム画面(グラフ)のルート候補: ホーム、このアプリの親フォルダ、いま動いているセッションの作業フォルダ
    const suggested = [os.homedir(), path.dirname(ROOT_DIR), ...[...sessions.values()].map((s) => s.cwd)];
    res.json({ command: DEFAULT_COMMAND, cwd: os.homedir(), suggestedRoots: [...new Set(suggested)] });
  });

  // フォルダ構造グラフ(親子 / import 依存)。読み取り専用。
  app.post('/api/graph', async (req, res) => {
    try {
      const b = req.body || {};
      const roots = Array.isArray(b.roots) ? b.roots.filter((x) => typeof x === 'string') : [];
      const focus = typeof b.focus === 'string' && b.focus ? b.focus : null;
      if (!focus && !roots.length) return res.status(400).json({ error: 'roots か focus を指定してください' });
      res.json(await buildGraph({
        roots, focus, depth: b.depth, hidden: !!b.hidden, includeIgnored: !!b.includeIgnored, imports: !!b.imports,
      }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- アプリ一覧(Web アプリ / コマンドアプリ) ----
  app.get('/api/apps', (_req, res) => res.json({ appsPort: APPS_PORT, apps: appsStore.list() }));
  app.post('/api/apps', (req, res) => {
    try { res.status(201).json(appsStore.create(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.put('/api/apps/:id', (req, res) => {
    try {
      const a = appsStore.update(req.params.id, req.body || {});
      if (!a) return res.status(404).json({ error: 'not found' });
      res.json(a);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.delete('/api/apps/:id', (req, res) => {
    if (!appsStore.remove(req.params.id)) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  });
};
