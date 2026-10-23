'use strict';
// 監査ログ・差分・worktree・ツール・窓口の API

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

  // ---- 監査ログ・差分・worktree ----
  app.get('/api/audit', wrap((req) => audit.query({
    days: Number(req.query.days) || 2,
    agent: String(req.query.agent || ''),
    kind: String(req.query.kind || ''),
    q: String(req.query.q || ''),
    limit: Math.min(5000, Number(req.query.limit) || 1000),
  })));

  // エージェント(セッション / ジョブ)の作業場所と、差分の起点
  function agentWorkspace(id) {
    const s = sessions.get(id);
    if (s) return { cwd: s.cwd, worktree: s.worktree, alive: s.alive, kind: 'session', name: s.name };
    const j = jobs.get(id);
    if (j) return { cwd: j.cwd, worktree: j.worktreeInfo, alive: j.status === 'running', kind: 'job', name: j.name };
    throw new Error('エージェントが見つかりません');
  }

  app.get('/api/diff', wrap((req) => {
    const w = agentWorkspace(String(req.query.agent || ''));
    if (w.worktree && w.worktree.removed) return { repo: null, error: 'worktree は削除済みです(ブランチ ' + w.worktree.branch + ' は残っています)', worktree: w.worktree };
    if (!fs.existsSync(w.cwd)) return { repo: null, error: `フォルダがありません: ${w.cwd}` };
    return { ...gitx.diff(w.cwd, w.worktree ? w.worktree.base : null), worktree: w.worktree || null, name: w.name };
  }));

  app.post('/api/worktree/remove', wrap((req) => {
    const id = String(req.body?.agent || '');
    const w = agentWorkspace(id);
    if (!w.worktree || w.worktree.removed) throw new Error('worktree はありません');
    if (w.alive) throw new Error('実行中は削除できません。終了してから削除してください');
    const r = gitx.removeWorktree(w.worktree, { force: !!req.body?.force });
    const info = { ...w.worktree, removed: true, removedAt: Date.now() };
    if (w.kind === 'session') { const s = sessions.get(id); s.worktree = info; emit(s); persist(); } else jobs.patch(id, { worktreeInfo: info });
    audit.log({ agent: id, agentName: w.name, kind: 'worktree-remove', target: w.worktree.path, detail: `branch ${w.worktree.branch} は残しました` });
    return r;
  }));

  // ---- worktree の取り込み(コミット / 元のブランチへマージ / push して PR)----
  function liveWorktree(id) {
    const w = agentWorkspace(id);
    if (!w.worktree || w.worktree.removed) throw new Error('worktree で動いていないか、すでに削除されています');
    return w;
  }

  app.post('/api/worktree/commit', wrap((req) => {
    const id = String(req.body?.agent || '');
    const w = liveWorktree(id);
    const r = gitx.commitAll(w.worktree, req.body?.message);
    if (r.committed) audit.log({ agent: id, agentName: w.name, kind: 'worktree-commit', target: w.worktree.branch, detail: r.commit });
    return r;
  }));

  app.post('/api/worktree/merge', wrap((req) => {
    const id = String(req.body?.agent || '');
    const w = liveWorktree(id);
    if (w.alive && req.body?.commitFirst) throw new Error('実行中はコミットしてから取り込めません。終了してから行ってください');
    const c = req.body?.commitFirst ? gitx.commitAll(w.worktree, req.body?.message) : { committed: false };
    const r = gitx.mergeInto(w.worktree, { squash: !!req.body?.squash, message: req.body?.mergeMessage });
    audit.log({ agent: id, agentName: w.name, kind: 'worktree-merge', target: `${w.worktree.branch} → ${r.into}`, detail: `${r.commits} コミット${req.body?.squash ? '(squash)' : ''} ${r.commit}` });
    return { ...r, committed: c.committed };
  }));

  app.post('/api/worktree/push', wrap((req) => {
    const id = String(req.body?.agent || '');
    const w = liveWorktree(id);
    if (w.alive && req.body?.commitFirst) throw new Error('実行中はコミットしてから push できません。終了してから行ってください');
    const c = req.body?.commitFirst ? gitx.commitAll(w.worktree, req.body?.message) : { committed: false };
    const r = gitx.pushBranch(w.worktree);
    audit.log({ agent: id, agentName: w.name, kind: 'worktree-push', target: w.worktree.branch, detail: r.url || r.remote });
    return { ...r, committed: c.committed };
  }));

  // ---- ツール(MCP サーバー・skills など)----
  app.get('/api/tools', wrap((req) => {
    let cwd = null;
    try { cwd = req.query.cwd ? resolveCwd(String(req.query.cwd)) : null; } catch (_) { cwd = null; }
    return { servers: tools.list(), claudeServers: claudeMcpServers(cwd), extensions: claudeExtensions(cwd), cwd };
  }));
  app.post('/api/tools/servers', wrap((req) => tools.create(req.body || {})));
  app.put('/api/tools/servers/:id', wrap((req) => {
    const r = tools.update(req.params.id, req.body || {});
    if (!r) throw new Error('見つかりません');
    return r;
  }));
  app.delete('/api/tools/servers/:id', wrap((req) => { if (!tools.remove(req.params.id)) throw new Error('見つかりません'); }));
  app.post('/api/tools/servers/:id/check', async (req, res) => {
    try { res.json(await tools.check(req.params.id)); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  // Claude Code 自身の「claude mcp list」(接続確認つき)
  app.post('/api/tools/claude-mcp-list', async (req, res) => {
    try {
      const cwd = resolveCwd(String(req.body?.cwd || ''));
      assertCommandExists(JOB_COMMAND, SHELL, cwd);
      const r = await runClaude('mcp list', { cwd, timeoutMs: 90000 });
      res.json({ cwd, output: `${r.out}${r.err ? `\n${r.err}` : ''}`.trim(), code: r.code });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---- 窓口(やりたいことから実行案を作る)----
  app.post('/api/dispatch/plan', async (req, res) => {
    try {
      const b = req.body || {};
      const roots = Array.isArray(b.roots) ? b.roots.filter((x) => typeof x === 'string').slice(0, 10) : [];
      const recent = [...new Set([
        ...[...sessions.values()].sort((x, y) => y.createdAt - x.createdAt).map((x) => (x.worktree ? x.worktree.origCwd : x.cwd)),
        ...jobs.list().sort((x, y) => y.createdAt - x.createdAt).map((j) => (j.worktreeInfo ? j.worktreeInfo.origCwd : j.cwd)),
      ])].slice(0, 15);
      let ask = null;
      if (b.useClaude !== false) {
        try {
          assertCommandExists(JOB_COMMAND, SHELL, os.homedir());
          const model = /^[A-Za-z0-9._-]{1,40}$/.test(settings.dispatchModel || '') ? settings.dispatchModel : 'haiku';
          ask = async (prompt) => {
            // ツールなし・保存なし・hooks なし(--settings を渡さない)で 1 回だけ答えさせる
            const r = await runClaude(`-p --output-format json --model ${model} --tools "" --no-session-persistence --strict-mcp-config`, { cwd: os.homedir(), input: prompt, timeoutMs: 90000 });
            let j = null;
            try { j = JSON.parse(r.out); } catch (_) { /* ignore */ }
            if (!j || j.is_error) throw new Error((j && (j.result || j.subtype)) || r.err.trim().split('\n').pop() || `終了コード ${r.code}`);
            return j.result;
          };
        } catch (_) { ask = null; }
      }
      res.json(await dispatch.plan(b.text, { roots, recent, fallbackCwd: os.homedir(), ask }));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/dispatch/run', wrap((req) => {
    const p = req.body || {};
    const prompt = String(p.prompt || '').trim();
    if (!prompt) throw new Error('プロンプトが空です');
    const mcpServers = Array.isArray(p.mcpServers) ? p.mcpServers : undefined;
    let out;
    if (p.mode === 'job') {
      out = { kind: 'job', job: jobs.create({ name: p.name, prompt, cwd: p.cwd, model: p.model, permissionMode: p.permissionMode || '', worktree: !!p.worktree, priority: p.priority, mcpServers, memory: p.memory }, { source: 'ui' }) };
    } else {
      const cmd = isClaudeCommand(DEFAULT_COMMAND) ? DEFAULT_COMMAND : JOB_COMMAND;
      const modelArg = p.model && /^[A-Za-z0-9._:-]{1,40}$/.test(p.model) ? ` --model ${p.model}` : '';
      out = { kind: 'session', session: publicInfo(createSession({ name: p.name, cwd: p.cwd, command: cmd + modelArg, worktree: !!p.worktree, prompt, mcpServers, memory: p.memory })) };
    }
    audit.log({ agent: out.kind === 'job' ? out.job.id : out.session.id, agentName: p.name, kind: 'dispatch', target: prompt.slice(0, 300), detail: `${out.kind}${p.worktree ? ' / worktree' : ''}` });
    return out;
  }));
};
