'use strict';
// ボード(メッセージと共有メモリ・候補の承認・点検・棚卸し)の API

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
    claudeMcpServers, claudeExtensions, targetOf, memoryPrompt, memoryPromptLib,
    DEFAULT_COMMAND, JOB_COMMAND, SHELL, IS_WIN, PERMISSION_WAIT, APPS_PORT, ROOT_DIR
  } = ctx;

  // ---- ボード(メッセージと共有メモリを人が見る・書く)----
  app.get('/api/board', wrap(() => ({
    messages: bus.messages(),
    memory: bus.memSearch('', { limit: 2000 }),
    candidates: bus.candidates(),
    lint: memoryPromptLib.lint(bus.memSearch('', { limit: 2000 })),
    memoryLearn: !!settings.memoryLearn,
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
    const meta = {};
    if (b.priority !== undefined) meta.priority = b.priority;
    if (b.expires !== undefined) meta.expires = b.expires;
    if (b.verified !== undefined) meta.verified = !!b.verified;
    return bus.memWrite(b.key, b.value, { tags: b.tags, author: 'あなた', meta });
  }));
  app.delete('/api/board/memory', wrap((req) => { if (!bus.memDelete(String(req.query.key || ''))) throw new Error('見つかりません'); }));
  app.post('/api/board/memory/verify', wrap((req) => {
    const b = req.body || {};
    const m = bus.memVerify(String(b.key || ''), b.verified !== false);
    if (!m) throw new Error('見つかりません');
    return m;
  }));

  // 最初に渡す内容のプレビュー(何を何 KB 渡すか)。query は新規セッション・ジョブ・窓口の「共有メモリから最初に渡す」と同じ書き方
  app.post('/api/board/memory/preview', wrap((req) => {
    const q = (req.body || {}).query;
    if (q !== undefined && typeof q !== 'string') throw new Error('query は文字列で指定してください');
    const r = memoryPrompt(String(q || '').slice(0, 500));
    return { ...r, text: r.text.slice(0, 60000) };
  }));

  // ---- 候補(エージェントが memory_propose で出した提案)----
  app.post('/api/board/candidates/:id/approve', wrap((req) => {
    const v = (req.body || {}).value;
    if (v !== undefined && typeof v !== 'string') throw new Error('value は文字列で指定してください');
    return bus.approveCandidate(String(req.params.id), { value: v });
  }));
  app.delete('/api/board/candidates/:id', wrap((req) => { if (!bus.rejectCandidate(String(req.params.id))) throw new Error('候補が見つかりません'); }));

  // ---- 棚卸し(矛盾・重複・古い項目を探して候補を出すジョブ)----
  //   when: 'now' = 今すぐジョブを 1 つ登録 / 'weekly' = 毎週のオートメーションを登録(同じものがあればそれを返す)
  //   権限は dontAsk(確認が要る操作は拒否)。memoryReview の印で、共有バスのツールを読む・候補を出す・人に知らせるだけに絞る
  //   (agents.js で強制。共有メモリを直接書き換えたり、ほかのエージェントに送ったりはできない)
  const REVIEW_NAME = '共有メモリの棚卸し';
  app.post('/api/board/memory/review', wrap((req) => {
    if (settings.busEnabled === false) throw new Error('共有バスがオフです。設定で「共有バスを使う」をオンにしてください');
    const when = (req.body || {}).when === 'weekly' ? 'weekly' : 'now';
    const template = { name: REVIEW_NAME, prompt: memoryPromptLib.REVIEW_PROMPT, cwd: os.homedir(), permissionMode: 'dontAsk', priority: 'low', memoryReview: true };
    if (when === 'now') return { kind: 'job', job: jobs.create(template, { source: 'ui' }) };
    const existing = automations.list().find((a) => a.name === REVIEW_NAME);
    if (existing) return { kind: 'automation', automation: existing, existed: true };
    return { kind: 'automation', automation: automations.create({ name: REVIEW_NAME, kind: 'cron', cron: '0 9 * * 1', template }) };
  }));
};
