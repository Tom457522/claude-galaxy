'use strict';
// エージェント(対話セッション・ジョブ)の名前解決と、共有バス(mcp-bus.js)のツール呼び出しの処理

function createAgents({ sessions, jobs, bus, maxDepth, maxAgentJobs }) {
  function agentName(id) {
    if (id === 'user') return 'あなた';
    if (id === 'all') return '全員';
    const s = sessions.get(id);
    if (s) return s.name;
    const j = jobs.get(id);
    return j ? j.name : id;
  }

  function agentList() {
    return [
      ...[...sessions.values()].filter((s) => s.alive).map((s) => ({
        id: s.id, kind: 'session', name: s.name, cwd: s.cwd, status: s.status, detail: s.statusDetail,
      })),
      ...jobs.list().filter((j) => j.status === 'queued' || j.status === 'running').map((j) => ({
        id: j.id, kind: 'job', name: j.name, cwd: j.cwd, status: j.status, parent: j.parent,
      })),
    ];
  }

  // 宛先の解決: ID / 名前(大文字小文字を区別しない)/ user / all / parent
  function resolveAgent(to, from) {
    const t = String(to || '').trim();
    if (!t) throw new Error('宛先を指定してください');
    if (t === 'user' || t === 'all') return t;
    if (t === 'parent') {
      const j = jobs.get(from);
      if (!j || !j.parent) throw new Error('あなたを登録したエージェントはいません');
      return j.parent;
    }
    if (sessions.has(t) || jobs.get(t)) return t;
    const low = t.toLowerCase();
    const hit = agentList().find((a) => a.name.toLowerCase() === low) ||
      [...sessions.values()].find((s) => s.name.toLowerCase() === low);
    if (!hit) throw new Error(`宛先が見つかりません: ${t}(list_agents で確認してください)`);
    return hit.id;
  }

  const jobSummary = (j) => ({
    id: j.id, name: j.name, status: j.status, parent: j.parent, cwd: j.cwd, createdAt: j.createdAt, endedAt: j.endedAt,
    costUsd: j.costUsd, result: j.result, error: j.error, lastText: j.status === 'running' ? j.lastText : undefined,
  });
  const msgOut = (m) => ({ id: m.id, from: m.from, fromName: m.fromName, to: m.to, text: m.text, at: new Date(m.at).toISOString(), replyTo: m.replyTo });

  // 入力待ちの対話セッションに、文章を貼り付けて送信する(ブラケットペーストで複数行もまとめて入る)
  function typeInto(s, text) {
    s.proc.write(`\x1b[200~${text.replace(/\x1b/g, '')}\x1b[201~`);
    setTimeout(() => { if (s.alive) s.proc.write('\r'); }, 150);
  }

  // MCP サーバー(mcp-bus.js)からのツール呼び出し
  async function busCall(from, tool, a) {
    const me = sessions.get(from) || jobs.get(from);
    if (!me) throw new Error('呼び出し元のエージェントが見つかりません');
    const myName = agentName(from);
    switch (tool) {
      case 'whoami': {
        const j = jobs.get(from);
        return { id: from, name: myName, kind: j ? 'job' : 'session', parent: j ? j.parent : null };
      }
      case 'list_agents':
        return { you: from, agents: agentList(), note: 'メッセージは ID か名前で送れます。"user" はこのアプリを使っている人です。' };
      case 'send_message': {
        const to = resolveAgent(a.to, from);
        const m = bus.send({ from, fromName: myName, to, toName: agentName(to), text: a.text, replyTo: typeof a.reply_to === 'string' ? a.reply_to : null });
        return { sent: m.id, to, toName: m.toName };
      }
      case 'read_messages':
        return bus.inbox(from, { unreadOnly: !a.include_read }).map(msgOut);
      case 'send_prompt': {
        const to = resolveAgent(a.to, from);
        const s = sessions.get(to);
        if (!s || !s.alive) throw new Error('送り先は実行中の対話セッションにしてください');
        if (to === from) throw new Error('自分には送れません');
        if (!['idle', 'done'].includes(s.status)) throw new Error(`相手は今「${s.status}」なので送れません。send_message で送ってください`);
        const text = String(a.text || '').trim().slice(0, 20000);
        if (!text) throw new Error('本文が空です');
        bus.send({ from, fromName: myName, to, toName: s.name, text: `(プロンプトとして入力)\n${text}` });
        bus.inbox(to, { unreadOnly: true }); // 入力したものは既読扱い
        typeInto(s, `[${myName} (${from}) から] ${text}`);
        return { typedInto: to };
      }
      case 'submit_job': {
        const depth = (jobs.get(from)?.depth || 0) + 1;
        if (depth > maxDepth) throw new Error(`ジョブからジョブを登録できるのは ${maxDepth} 段までです`);
        const active = jobs.list().filter((j) => j.source === 'agent' && (j.status === 'queued' || j.status === 'running')).length;
        if (active >= maxAgentJobs) throw new Error(`エージェントが登録した待ち・実行中のジョブが上限(${maxAgentJobs})に達しています`);
        const j = jobs.create({
          prompt: a.prompt, name: a.name, cwd: a.cwd, model: a.model,
          permissionMode: a.permission_mode || '', priority: a.priority, maxBudgetUsd: a.max_budget_usd,
        }, { strict: true, source: 'agent', parent: from, depth, defaultCwd: me.cwd });
        return { id: j.id, name: j.name, status: j.status, note: '終わると結果があなた宛てのメッセージでも届きます。get_job で待つこともできます。' };
      }
      case 'get_job': {
        const j = await jobs.wait(String(a.id || ''), Math.min(240, Math.max(0, Number(a.wait_seconds) || 0)) * 1000);
        if (!j) throw new Error(`ジョブが見つかりません: ${a.id}`);
        return jobSummary(j);
      }
      case 'list_jobs':
        return jobs.list()
          .filter((j) => (!a.status || j.status === a.status) && (!a.mine || j.parent === from))
          .sort((x, y) => y.createdAt - x.createdAt).slice(0, 50)
          .map((j) => ({ ...jobSummary(j), result: j.result ? j.result.slice(0, 300) : '' }));
      case 'cancel_job': {
        const j = jobs.get(String(a.id || ''));
        if (!j) throw new Error('ジョブが見つかりません');
        if (j.parent !== from) throw new Error('自分が登録したジョブだけ中止できます');
        return { canceled: jobs.cancel(j.id) };
      }
      case 'memory_write':
        return bus.memWrite(a.key, a.value, {
          tags: a.tags,
          author: `${myName} (${from})`,
          source: { kind: sessions.has(from) ? 'session' : 'job', id: from },
        });
      case 'memory_read':
        return bus.memRead(String(a.key || '')) || { error: 'そのキーはありません' };
      case 'memory_search':
        return bus.memSearch(a.query, { prefix: typeof a.prefix === 'string' ? a.prefix : '' });
      case 'memory_delete':
        return { deleted: bus.memDelete(String(a.key || '')) };
      default:
        throw new Error(`unknown tool: ${tool}`);
    }
  }

  return { agentName, agentList, resolveAgent, typeInto, busCall };
}

module.exports = { createAgents };
