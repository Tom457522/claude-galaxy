'use strict';
// 自己診断・全文検索・バックアップと復元・予算の API

module.exports = function routes(ctx) {
  const {
    app, wrap, sessions, jobs, bus, store, budget, diagnose, search, waitDiagHook, tokenFor, runClaude, assertCommandExists, audit,
    HOOK_JS, MCP_JS, TMP_DIR, PORT, SHELL, JOB_COMMAND,
  } = ctx;

  // 自己診断(数秒〜数十秒かかる)
  app.get('/api/doctor', async (_req, res) => {
    try {
      res.json(await diagnose({
        shell: SHELL,
        jobCommand: JOB_COMMAND,
        checkCommand: (cmd, cwd) => assertCommandExists(cmd, SHELL, cwd),
        runClaude,
        hookPath: HOOK_JS,
        mcpPath: MCP_JS,
        port: PORT,
        diagToken: () => tokenFor('diag'),
        waitDiagHook,
        dataDir: store.DATA_DIR,
        tmpDir: TMP_DIR,
      }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/search', wrap((req) => search(String(req.query.q || ''), {
    sessions: () => [...sessions.values()].map((s) => ({ id: s.id, name: s.name })),
    jobs: () => jobs.list(),
    transcript: (id) => jobs.transcript(id),
    messages: () => bus.messages(1000),
    memory: () => bus.memSearch('', { limit: 2000 }),
  })));

  // バックアップ: ダウンロードさせる。secrets=1 なら MCP サーバーの秘密の値も含める
  app.get('/api/backup', (req, res) => {
    const secrets = req.query.secrets === '1';
    const d = new Date();
    const name = `claude-galaxy-backup-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.json(store.exportBackup({ secrets }));
  });
  // 復元: 次の起動時に反映する(動いているサーバーの保存で上書きされないように)
  app.post('/api/restore', wrap((req) => {
    const names = store.stageRestore(req.body && req.body.bundle);
    audit.log({ agent: 'user', agentName: 'あなた', kind: 'restore', detail: names.join(', ') });
    return { staged: names, note: '次にサーバーを起動したときに反映します。いったん止めて、もう一度起動してください。' };
  }));
  app.get('/api/restore', wrap(() => ({ pending: store.pendingRestore() })));

  app.get('/api/budget', wrap(() => budget.status()));
};
