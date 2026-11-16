'use strict';
// 自己診断・全文検索・バックアップと復元・予算・使用量・おすすめ設定の API

module.exports = function routes(ctx) {
  const {
    app, wrap, sessions, settings, jobs, automations, bus, store, budget, plan, cloud, usageScan, diagnose, search, waitDiagHook, tokenFor, runClaude, askClaude, recommend, assertCommandExists, audit,
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
  // Claude Code 全体の使用量(~/.claude/projects のトランスクリプトから数えた概算)
  // source=all|local|cloud。クラウドの分は 10 分ごとに読んでいるものを使う(refresh=1 なら読み直す)
  app.get('/api/usage', async (req, res) => {
    try {
      if (req.query.refresh === '1') await cloud.refresh();
      res.json({ ...usageScan.report({ days: req.query.days, source: String(req.query.source || 'all') }), cloud: cloud.status() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // クラウドセッションの一覧(状態・リポジトリ・Claude Code が数えた累計額)
  app.get('/api/cloud-sessions', wrap(() => ({ ...cloud.status(), sessions: cloud.sessions() })));
  // プランの実際の利用率と、各制限の期間に使った API 換算コスト(1 時間ごと)
  app.get('/api/plan', async (req, res) => {
    try {
      const st = req.query.refresh === '1' || !plan.status().fetchedAt ? await plan.refresh() : plan.status();
      const now = Date.now();
      const windows = {};
      for (const l of st.limits) {
        if (!l.startsAt || windows[l.group]) continue;
        windows[l.group] = usageScan.between({ from: l.startsAt, to: Math.min(now, l.resetsAt), bucketMs: l.group === 'session' ? 15 * 60 * 1000 : 60 * 60 * 1000 });
      }
      const d = new Date(now);
      const month = usageScan.between({ from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: now, bucketMs: 24 * 60 * 60 * 1000 });
      res.json({ ...st, windows, month: { cost: month.cost, tokens: month.tokens } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // おすすめ設定: 使い方の数値から変更案を作る(保存はしない。画面で選んでから PUT /api/settings で保存する)
  const recFacts = () => {
    let usage = null;
    try { usage = usageScan.report({ days: 30, source: 'all' }); } catch (_) { usage = null; }
    return recommend.facts({
      settings, usage, plan: plan.status(), jobs: jobs.list(), automations: automations.list(),
      vaults: settings.memoryExportVault ? [] : recommend.findVaults(),
    });
  };
  // GET /api/settings/recommend?preset=save|unattended|safe … 規則だけで作る(Claude を呼ばない)
  app.get('/api/settings/recommend', wrap((req) => {
    const f = recFacts();
    const name = req.query.preset ? String(req.query.preset) : '';
    return {
      facts: { plan: f.plan, usage: f.usage, jobs: f.jobs, automations: f.automations },
      presets: recommend.presets(),
      preset: name || null,
      items: name ? recommend.preset(name, f, settings) : recommend.recommend(f, settings),
    };
  }));
  // POST /api/settings/recommend/ai … 数値と設定値だけを Claude(ツールなし)に渡し、案の見直しと理由を作らせる
  let recAiBusy = false; // 料金がかかるので、同時に 1 つだけ走らせる(連打・別タブ)
  app.post('/api/settings/recommend/ai', async (_req, res) => {
    if (recAiBusy) return res.status(409).json({ error: 'いま Claude に見直してもらっています。終わるまでお待ちください' });
    recAiBusy = true;
    try {
      const f = recFacts();
      const rules = recommend.recommend(f, settings);
      const ai = recommend.parseAi(await askClaude(recommend.aiPrompt(f, rules), { timeoutMs: 120000 }), settings);
      if (!ai) throw new Error('Claude の答えを読めませんでした。もう一度試してください');
      // AI が扱わない項目(書き出し先など)の規則の案は残す
      // id が AI の案と重ならないよう rule- を付ける(画面は id で選択を管理する)
      const keep = rules.filter((r) => Object.keys(r.patch).some((k) => recommend.KEYS[k].noAi)).map((r) => ({ ...r, id: `rule-${r.id}` }));
      res.json({ summary: ai.summary, items: [...ai.items, ...keep] });
    } catch (e) { res.status(400).json({ error: e.message }); } finally { recAiBusy = false; }
  });
};
