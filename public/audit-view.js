'use strict';
// 記録タブ(監査ログ)と、差分ダイアログ(セッション / ジョブの作業場所の git diff・worktree の片付け)

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  const KINDS = {
    tool: { label: 'ツール', icon: '▸' },
    permission: { label: '権限', icon: '⚑' },
    'session-start': { label: '起動', icon: '▶' },
    'session-exit': { label: '終了', icon: '■' },
    'job-start': { label: 'ジョブ開始', icon: '◷' },
    'job-end': { label: 'ジョブ終了', icon: '✓' },
    dispatch: { label: '窓口', icon: '➤' },
    'worktree-remove': { label: 'worktree 削除', icon: '⑂' },
  };

  const S = { list: [], visible: false, timer: null, diffAgent: null, opts: {} };

  // ---------- 記録 ----------
  function filters() {
    return {
      days: $('#au-days').value,
      kind: $('#au-kind').value,
      agent: $('#au-agent').value.trim(),
      q: $('#au-q').value.trim(),
    };
  }

  async function load() {
    const f = filters();
    const qs = new URLSearchParams({ days: f.days, kind: f.kind, agent: f.agent, q: f.q, limit: '2000' });
    try { S.list = await api('GET', `/api/audit?${qs}`); } catch (e) { S.list = []; console.error(e); }
    render();
  }

  function render() {
    const fmt = (t) => new Date(t).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $('#au-count').textContent = `${S.list.length} 件`;
    $('#au-list').innerHTML = S.list.length ? S.list.map((e) => {
      const k = KINDS[e.kind] || { label: e.kind, icon: '·' };
      return `<div class="au-row au-${esc(e.kind)}">` +
        `<span class="au-time">${fmt(e.t)}</span>` +
        `<span class="au-agent" data-agent="${esc(e.agent)}" title="このエージェントだけ表示">${esc(e.agentName || e.agent)}<small>${esc(e.agent)}</small></span>` +
        `<span class="au-kind">${k.icon} ${esc(k.label)}</span>` +
        `<span class="au-body">${e.tool ? `<b>${esc(e.tool)}</b> ` : ''}${esc(e.target || '')}${e.detail ? `<em>${esc(e.detail)}</em>` : ''}</span>` +
        `<button class="icon-btn au-diff" data-diff="${esc(e.agent)}" title="このエージェントの作業場所の差分">±</button>` +
      '</div>';
    }).join('') : '<p class="jobs-empty">記録はありません</p>';
  }

  // ---------- 差分 ----------
  function diffHtml(text) {
    if (!text) return '<p class="jobs-empty">差分はありません</p>';
    return text.split('\n').map((l) => {
      let c = '';
      if (l.startsWith('diff --git')) c = 'df-file';
      else if (l.startsWith('@@')) c = 'df-hunk';
      else if (l.startsWith('+') && !l.startsWith('+++')) c = 'df-add';
      else if (l.startsWith('-') && !l.startsWith('---')) c = 'df-del';
      else if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l)) c = 'df-meta';
      return `<div class="${c}">${esc(l) || ' '}</div>`;
    }).join('');
  }

  async function openDiff(agent) {
    S.diffAgent = agent;
    $('#df-title').textContent = `差分  (${agent})`;
    $('#df-meta').innerHTML = '';
    $('#df-body').innerHTML = '<p class="jobs-empty">読み込み中…</p>';
    $('#df-wt').classList.add('hidden');
    if (!$('#dlg-diff').open) $('#dlg-diff').showModal();
    let d;
    try { d = await api('GET', `/api/diff?agent=${encodeURIComponent(agent)}`); } catch (e) { d = { error: e.message }; }
    if (S.diffAgent !== agent) return;
    $('#df-title').textContent = `差分  ${d.name ? `${d.name} ` : ''}(${agent})`;
    const wt = d.worktree;
    $('#df-meta').innerHTML = [
      d.repo && `<span>リポジトリ ${esc(d.repo)}</span>`,
      d.branch && `<span>ブランチ <b>${esc(d.branch)}</b></span>`,
      d.base && `<span>起点 ${esc(d.base.slice(0, 8))}${wt ? '(worktree を作った時点)' : '(HEAD)'}</span>`,
      wt && `<span>worktree ${esc(wt.path)}${wt.removed ? '(削除済み)' : ''}</span>`,
      d.truncated && '<span class="df-warn">大きいため途中まで表示</span>',
    ].filter(Boolean).join('');
    if (d.error) { $('#df-body').innerHTML = `<p class="error">${esc(d.error)}</p>`; return; }
    const parts = [];
    if (d.commits && d.commits.length) parts.push(`<div class="df-sec"><b>コミット(${d.commits.length})</b><pre>${esc(d.commits.join('\n'))}</pre></div>`);
    if (d.stat) parts.push(`<div class="df-sec"><b>変更の概要</b><pre>${esc(d.stat)}</pre></div>`);
    if (d.untracked && d.untracked.length) parts.push(`<div class="df-sec"><b>新しいファイル(${d.untracked.length})</b><pre>${esc(d.untracked.join('\n'))}</pre></div>`);
    parts.push(`<div class="df-diff">${diffHtml(d.diff)}</div>`);
    $('#df-body').innerHTML = parts.join('');
    $('#df-wt').classList.toggle('hidden', !wt || !!wt.removed);
  }

  async function removeWorktree(force) {
    const agent = S.diffAgent;
    if (!agent) return;
    const msg = force
      ? 'worktree を、コミットしていない変更ごと削除しますか?(ブランチとコミット済みの変更は残ります)'
      : 'worktree を削除しますか?(ブランチは残ります)';
    if (!confirm(msg)) return;
    try {
      const r = await api('POST', '/api/worktree/remove', { agent, force });
      alert(`worktree を削除しました。ブランチ ${r.branch} は残っています(git merge / git branch -D で片付けられます)。`);
      openDiff(agent);
    } catch (e) { alert(e.message); }
  }

  function bind() {
    for (const id of ['#au-days', '#au-kind']) $(id).addEventListener('change', load);
    for (const id of ['#au-agent', '#au-q']) {
      $(id).addEventListener('input', () => { clearTimeout(S.timer); S.timer = setTimeout(load, 300); });
    }
    $('#au-reload').addEventListener('click', load);
    $('#au-list').addEventListener('click', (e) => {
      const d = e.target.closest('[data-diff]');
      if (d) { openDiff(d.dataset.diff); return; }
      const a = e.target.closest('[data-agent]');
      if (a) { $('#au-agent').value = a.dataset.agent; load(); }
    });
    $('#au-on').addEventListener('change', async (e) => {
      try { await api('PUT', '/api/settings', { auditEnabled: e.target.checked }); } catch (err) { alert(err.message); }
    });
    $('#au-keep').addEventListener('change', async (e) => {
      try { await api('PUT', '/api/settings', { auditDays: Number(e.target.value) }); } catch (err) { alert(err.message); }
    });
    $('#df-close').addEventListener('click', () => $('#dlg-diff').close());
    $('#df-reload').addEventListener('click', () => S.diffAgent && openDiff(S.diffAgent));
    $('#df-rm').addEventListener('click', () => removeWorktree(false));
    $('#df-rm-force').addEventListener('click', () => removeWorktree(true));
    $('#dlg-diff').addEventListener('close', () => { S.diffAgent = null; });
  }

  window.AuditView = {
    init(opts) { S.opts = opts || {}; bind(); },
    show() { S.visible = true; load(); },
    hide() { S.visible = false; },
    // 新しい記録が増えたら、表示中なら読み直す(まとめて)
    onEntry() { if (!S.visible) return; clearTimeout(S.timer); S.timer = setTimeout(load, 800); },
    onSettings(st) {
      $('#au-on').checked = st.auditEnabled !== false;
      if (st.auditDays) $('#au-keep').value = String(st.auditDays);
    },
    filterAgent(id) { $('#au-agent').value = id; load(); },
  };
  window.DiffView = { open: openDiff };
})();
