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
    'worktree-commit': { label: 'コミット', icon: '⑂' },
    'worktree-merge': { label: '取り込み', icon: '⑂' },
    'worktree-push': { label: 'push', icon: '⇡' },
    restore: { label: '復元の予約', icon: '↺' },
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
  // 差分をファイルごとに分ける
  function splitFiles(text) {
    const files = [];
    let cur = null;
    for (const l of String(text || '').split('\n')) {
      if (l.startsWith('diff --git')) {
        const m = / b\/(.+)$/.exec(l);
        cur = { name: m ? m[1] : l.slice(11), lines: [], add: 0, del: 0, meta: [] };
        files.push(cur);
        continue;
      }
      if (!cur) continue;
      if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(l)) { cur.meta.push(l); continue; }
      if (l.startsWith('+')) cur.add++;
      else if (l.startsWith('-')) cur.del++;
      cur.lines.push(l);
    }
    return files;
  }

  const cls = (l) => (l.startsWith('@@') ? 'df-hunk' : l.startsWith('+') ? 'df-add' : l.startsWith('-') ? 'df-del' : '');

  function unifiedHtml(lines) {
    return lines.map((l) => `<div class="${cls(l)}">${esc(l) || ' '}</div>`).join('');
  }

  // 左右に並べる: 削除行と追加行の並びを組にして表示する
  function splitHtml(lines) {
    const rows = [];
    let dels = [];
    let adds = [];
    const flush = () => {
      const n = Math.max(dels.length, adds.length);
      for (let i = 0; i < n; i++) rows.push([dels[i], adds[i]]);
      dels = []; adds = [];
    };
    for (const l of lines) {
      if (l.startsWith('-')) dels.push(l);
      else if (l.startsWith('+')) adds.push(l);
      else { flush(); rows.push(l.startsWith('@@') ? ['@@', l] : [l, l]); }
    }
    flush();
    return `<table class="df-split">${rows.map(([a, b]) => (a === '@@'
      ? `<tr class="df-hunk"><td colspan="2">${esc(b)}</td></tr>`
      : `<tr><td class="${a === undefined ? 'df-empty' : cls(a)}">${a === undefined ? '' : esc(a.replace(/^[- ]/, '')) || ' '}</td>` +
        `<td class="${b === undefined ? 'df-empty' : cls(b)}">${b === undefined ? '' : esc(b.replace(/^[+ ]/, '')) || ' '}</td></tr>`)).join('')}</table>`;
  }

  function diffHtml(text) {
    const files = splitFiles(text);
    if (!files.length) return '<p class="jobs-empty">差分はありません</p>';
    const split = S.split;
    const many = files.length > 8;
    return files.map((f) => `<details class="df-filebox" ${many ? '' : 'open'}>` +
      `<summary><span class="df-fname">${esc(f.name)}</span><span class="df-count"><b class="df-a">+${f.add}</b> <b class="df-d">−${f.del}</b></span>` +
      `${f.meta.some((m) => m.startsWith('new file')) ? '<span class="mem-tag">新規</span>' : ''}${f.meta.some((m) => m.startsWith('deleted file')) ? '<span class="mem-tag">削除</span>' : ''}</summary>` +
      `<div class="df-diff">${split ? splitHtml(f.lines) : unifiedHtml(f.lines)}</div></details>`).join('');
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
    parts.push(diffHtml(d.diff));
    $('#df-body').innerHTML = parts.join('');
    S.lastDiff = d;
    $('#df-wt').classList.toggle('hidden', !wt || !!wt.removed);
  }

  async function removeWorktree(force) {
    const agent = S.diffAgent;
    if (!agent) return;
    const msg = force
      ? 'worktree を、コミットしていない変更ごと削除しますか?(ブランチとコミット済みの変更は残ります)'
      : 'worktree を削除しますか?(ブランチは残ります)';
    if (!await UI.confirm(msg)) return;
    try {
      const r = await api('POST', '/api/worktree/remove', { agent, force });
      UI.toast(`worktree を削除しました。ブランチ ${r.branch} は残っています(git merge / git branch -D で片付けられます)。`);
      openDiff(agent);
    } catch (e) { UI.toast(e.message, { type: 'error' }); }
  }

  // worktree の変更を取り込む: コミット / 元のブランチにマージ / push して PR を作る
  async function wtAction(kind) {
    const agent = S.diffAgent;
    if (!agent) return;
    const message = $('#df-msg').value.trim();
    const d = S.lastDiff || {};
    const dirty = !!(d.diff && d.diff.trim()) || (d.untracked && d.untracked.length);
    try {
      if (kind === 'commit') {
        const r = await api('POST', '/api/worktree/commit', { agent, message });
        UI.toast(r.committed ? `コミットしました(${r.commit})` : 'コミットする変更はありません');
      } else if (kind === 'merge') {
        const squash = $('#df-squash').checked;
        if (!await UI.confirm(`${d.branch} の変更を、元のリポジトリでいま開いているブランチに${squash ? '1 つのコミットにまとめて' : ''}取り込みますか?${dirty ? '\nコミットしていない変更は、先にコミットします。' : ''}`, { ok: '取り込む' })) return;
        const r = await api('POST', '/api/worktree/merge', { agent, commitFirst: true, message, squash });
        UI.toast(`${r.into} に取り込みました(${r.commits} コミット・${r.commit})。worktree は「worktree を削除」で片付けられます`, { timeout: 8000 });
      } else if (kind === 'push') {
        if (!await UI.confirm(`${d.branch} を origin に push しますか?${dirty ? '\nコミットしていない変更は、先にコミットします。' : ''}`, { ok: 'push する' })) return;
        const r = await api('POST', '/api/worktree/push', { agent, commitFirst: true, message });
        if (r.url) {
          window.open(r.url, '_blank', 'noopener');
          UI.toast('push しました。PR を作る画面を開きました');
        } else {
          UI.toast(`push しました(${r.remote})。PR はリポジトリのサイトで作ってください`, { timeout: 8000 });
        }
      }
      openDiff(agent);
    } catch (e) { UI.toast(e.message, { type: 'error' }); }
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
    $('#df-close').addEventListener('click', () => $('#dlg-diff').close());
    $('#df-reload').addEventListener('click', () => S.diffAgent && openDiff(S.diffAgent));
    $('#df-rm').addEventListener('click', () => removeWorktree(false));
    $('#df-rm-force').addEventListener('click', () => removeWorktree(true));
    $('#df-commit').addEventListener('click', () => wtAction('commit'));
    $('#df-merge').addEventListener('click', () => wtAction('merge'));
    $('#df-push').addEventListener('click', () => wtAction('push'));
    $('#df-split').addEventListener('change', (e) => {
      S.split = e.target.checked;
      try { localStorage.setItem('diffSplit', S.split ? '1' : '0'); } catch (_) { /* ignore */ }
      if (S.lastDiff && !S.lastDiff.error) {
        const body = $('#df-body');
        for (const el of body.querySelectorAll('.df-filebox')) el.remove();
        body.insertAdjacentHTML('beforeend', diffHtml(S.lastDiff.diff));
      }
    });
    S.split = (() => { try { return localStorage.getItem('diffSplit') === '1'; } catch (_) { return false; } })();
    $('#df-split').checked = S.split;
    $('#dlg-diff').addEventListener('close', () => { S.diffAgent = null; });
  }

  window.AuditView = {
    init(opts) { S.opts = opts || {}; bind(); },
    show() { S.visible = true; load(); },
    hide() { S.visible = false; },
    // 新しい記録が増えたら、表示中なら読み直す(まとめて)
    onEntry() { if (!S.visible) return; clearTimeout(S.timer); S.timer = setTimeout(load, 800); },
    filterAgent(id) { $('#au-agent').value = id; load(); },
  };
  window.DiffView = { open: openDiff };
})();
