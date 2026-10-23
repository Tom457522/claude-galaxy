'use strict';
// ジョブ(claude -p のヘッドレス実行)とオートメーション(cron / ファイル変更 / git コミット)の画面

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const STATUS = {
    queued: { label: '待ち', icon: '◷' },
    running: { label: '実行中', icon: '◐' },
    done: { label: '完了', icon: '✓' },
    failed: { label: '失敗', icon: '✕' },
    canceled: { label: '中止', icon: '■' },
  };
  const PRIORITY = { high: '高', normal: '', low: '低' };
  const MODES = [
    ['', '既定(確認が要る操作は受信箱で。答えがなければ拒否)'],
    ['plan', 'plan(読むだけ・計画だけ)'],
    ['dontAsk', 'dontAsk(許可済みの操作だけ。それ以外は確認せず拒否)'],
    ['acceptEdits', 'acceptEdits(ファイル編集は確認なし)'],
    ['auto', 'auto(安全性の判定に任せる)'],
    ['bypassPermissions', 'bypassPermissions(すべて確認なし・注意)'],
  ];
  const KINDS = { cron: '⏱ 時刻', files: '✎ ファイル変更', git: '⑂ コミット' };
  const CRON_PRESETS = [
    ['毎時 0 分', '0 * * * *'], ['毎朝 9 時', '0 9 * * *'], ['平日 9 時', '0 9 * * 1-5'],
    ['毎晩 2 時', '0 2 * * *'], ['毎週月曜 9 時', '0 9 * * 1'], ['15 分ごと', '*/15 * * * *'],
  ];

  const S = { jobs: new Map(), autos: new Map(), max: 2, command: 'claude', opts: {}, editing: null, mode: 'job', detail: null };

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

  function fmtDur(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}秒`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}分${String(s % 60).padStart(2, '0')}秒`;
    return `${Math.floor(m / 60)}時間${m % 60}分`;
  }
  const fmtTime = (t) => (t ? new Date(t).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const fmtCost = (c) => (c > 0 ? (c < 0.01 ? '<$0.01' : `$${c.toFixed(2)}`) : '');
  const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  const firstLine = (t) => String(t || '').trim().split('\n')[0].slice(0, 200);

  function origin(j) {
    if (j.source === 'automation') {
      const a = S.autos.get(j.automationId);
      return `⚙ ${a ? a.name : 'オートメーション'}`;
    }
    if (j.source === 'agent') return `↳ ${j.parent}${S.opts.agentName ? ` ${S.opts.agentName(j.parent)}` : ''}`;
    return '';
  }

  // ---------- ジョブ一覧 ----------
  function jobRow(j) {
    const st = STATUS[j.status] || STATUS.queued;
    const live = j.status === 'running';
    const time = live ? `<span data-since="${j.startedAt}"></span>`
      : j.startedAt && j.endedAt ? fmtDur(j.endedAt - j.startedAt) : fmtTime(j.createdAt);
    const sub = live ? (j.lastTool ? `▸ ${j.lastTool}  ` : '') + firstLine(j.lastText)
      : j.status === 'queued' ? firstLine(j.prompt)
        : j.error ? `⚠ ${firstLine(j.error)}` : firstLine(j.result);
    const acts = [
      j.status === 'queued' || live ? '<button class="btn" data-jact="cancel">中止</button>' : '',
      !live && j.status !== 'queued' ? '<button class="btn" data-jact="retry" title="同じ内容でもう一度">再実行</button>' : '',
      j.claudeSessionId && !live ? '<button class="btn" data-jact="open" title="この会話をターミナルで開いて続ける(claude --resume)">ターミナルで</button>' : '',
      j.startedAt ? '<button class="icon-btn" data-jact="diff" title="作業場所の差分(git diff)">±</button>' : '',
      !live && j.status !== 'queued' ? '<button class="icon-btn" data-jact="remove" title="一覧から削除">✕</button>' : '',
    ].join('');
    const wt = j.worktreeInfo ? `⑂ ${j.worktreeInfo.branch}${j.worktreeInfo.removed ? '(削除済み)' : ''}` : (j.worktree && j.status === 'queued' ? '⑂ worktree' : '');
    const meta = [baseName(j.worktreeInfo ? j.worktreeInfo.origCwd : j.cwd), wt, j.model, PRIORITY[j.priority] && `優先度 ${PRIORITY[j.priority]}`, j.permissionMode, origin(j)]
      .filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('');
    return `<div class="job-row js-${j.status}" data-job="${esc(j.id)}">` +
      `<span class="job-st" title="${st.label}">${st.icon}</span>` +
      '<div class="job-main">' +
        `<div class="job-name"><b>${esc(j.name)}</b><small>${esc(j.id)}</small></div>` +
        `<div class="job-meta">${meta}</div>` +
        (sub ? `<div class="job-sub">${esc(sub)}</div>` : '') +
      '</div>' +
      `<div class="job-side"><span class="job-time">${time}</span><span class="job-cost">${fmtCost(j.costUsd)}</span></div>` +
      `<div class="job-acts">${acts}</div>` +
    '</div>';
  }

  function renderJobs() {
    const all = [...S.jobs.values()];
    const active = all.filter((j) => j.status === 'running' || j.status === 'queued')
      .sort((a, b) => (a.status === b.status ? a.createdAt - b.createdAt : a.status === 'running' ? -1 : 1));
    const done = all.filter((j) => !active.includes(j)).sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
    $('#jobs-active').innerHTML = active.length ? active.map(jobRow).join('') : '<p class="jobs-empty">実行中・待ちのジョブはありません</p>';
    $('#jobs-done').innerHTML = done.length ? done.slice(0, 100).map(jobRow).join('') : '<p class="jobs-empty">まだありません</p>';
    const running = active.filter((j) => j.status === 'running').length;
    $('#jobs-count').textContent = `実行中 ${running} / 待ち ${active.length - running}`;
    const spent = all.reduce((n, j) => n + (j.costUsd || 0), 0);
    $('#jobs-spent').textContent = spent ? `合計 ${fmtCost(spent)}` : '';
    tick();
    if (S.opts.onCounts) S.opts.onCounts({ running, queued: active.length - running });
    if (S.detail && S.jobs.has(S.detail)) renderDetailHead(S.jobs.get(S.detail));
  }

  function tick() {
    for (const el of document.querySelectorAll('#jobs [data-since]')) el.textContent = fmtDur(Date.now() - Number(el.dataset.since));
  }

  // ---------- オートメーション ----------
  function autoCard(a) {
    const when = a.kind === 'cron' ? `<code>${esc(a.cron)}</code>  次回 ${fmtTime(a.nextRun)}`
      : `${esc(a.watchPath)}${a.kind === 'files' ? `(${a.debounceSec}秒まとめる)` : ''}`;
    const last = a.lastFiredAt ? `前回 ${fmtTime(a.lastFiredAt)}${a.lastJobId ? ` → ${esc(a.lastJobId)}` : ''}` : 'まだ動いていません';
    return `<div class="auto-card${a.enabled ? '' : ' off'}" data-auto="${esc(a.id)}">` +
      '<div class="auto-head">' +
        `<label class="auto-sw" title="有効 / 無効"><input type="checkbox" data-aact="toggle" ${a.enabled ? 'checked' : ''}></label>` +
        `<b>${esc(a.name)}</b><span class="auto-kind">${KINDS[a.kind]}</span>` +
      '</div>' +
      `<div class="auto-when">${when}</div>` +
      `<div class="auto-prompt">${esc(firstLine(a.template && a.template.prompt))}</div>` +
      `<div class="auto-last">${last}${a.lastSkipped ? `  ・前のジョブが実行中のため見送り ${fmtTime(a.lastSkipped)}` : ''}</div>` +
      (a.error ? `<div class="auto-err">⚠ ${esc(a.error)}</div>` : '') +
      '<div class="auto-acts"><button class="btn" data-aact="run">今すぐ実行</button><button class="btn" data-aact="edit">編集</button>' +
      '<button class="icon-btn" data-aact="remove" title="削除">✕</button></div>' +
    '</div>';
  }

  function renderAutos() {
    const list = [...S.autos.values()].sort((a, b) => a.createdAt - b.createdAt);
    $('#autos-list').innerHTML = list.length ? list.map(autoCard).join('')
      : '<p class="jobs-empty">決まった時刻や、ファイルの変更・コミットをきっかけに、ジョブを自動で登録できます。</p>';
  }

  // ---------- 詳細 ----------
  function renderDetailHead(j) {
    const st = STATUS[j.status] || STATUS.queued;
    const u = j.usage;
    $('#jd-title').textContent = `${j.name}  (${j.id})`;
    $('#jd-meta').innerHTML = [
      `<span class="job-pill js-${j.status}">${st.icon} ${st.label}</span>`,
      `<span>${esc(j.cwd)}</span>`,
      j.model && `<span>モデル ${esc(j.model)}</span>`,
      j.permissionMode && `<span>権限 ${esc(j.permissionMode)}</span>`,
      j.maxBudgetUsd && `<span>予算 $${j.maxBudgetUsd}</span>`,
      origin(j) && `<span>${esc(origin(j))}</span>`,
      j.costUsd && `<span>コスト ${fmtCost(j.costUsd)}</span>`,
      u && `<span>トークン 入力 ${u.input} / 出力 ${u.output} / キャッシュ ${u.cacheRead + u.cacheWrite}</span>`,
      j.numTurns && `<span>${j.numTurns} ターン</span>`,
      j.claudeSessionId && `<span title="claude --resume で開けます">セッション ${esc(j.claudeSessionId)}</span>`,
      j.worktreeInfo && `<span title="${esc(j.worktreeInfo.path)}">⑂ worktree ${esc(j.worktreeInfo.branch)}${j.worktreeInfo.removed ? '(削除済み)' : ''}</span>`,
    ].filter(Boolean).join('');
    $('#jd-prompt').textContent = j.prompt;
    $('#jd-error').textContent = j.error || '';
    $('#jd-error').classList.toggle('hidden', !j.error);
  }

  async function openDetail(id) {
    const j = S.jobs.get(id);
    if (!j) return;
    S.detail = id;
    renderDetailHead(j);
    $('#jd-log').innerHTML = '<p class="jobs-empty">読み込み中…</p>';
    if (!$('#dlg-jobdetail').open) $('#dlg-jobdetail').showModal();
    await refreshTranscript();
  }

  async function refreshTranscript() {
    const id = S.detail;
    if (!id) return;
    let list = [];
    try { list = await api('GET', `/api/jobs/${id}/transcript`); } catch (_) { /* ignore */ }
    if (S.detail !== id) return;
    const log = $('#jd-log');
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
    log.innerHTML = list.length
      ? list.map((e) => `<div class="jl jl-${e.kind}${e.error ? ' jl-err' : ''}">${e.kind === 'tool' ? '▸ ' : e.kind === 'result' ? '◆ 結果\n' : ''}${esc(e.text)}</div>`).join('')
      : '<p class="jobs-empty">まだ出力はありません</p>';
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  // ---------- 追加 / 編集ダイアログ(ジョブとオートメーションで共用)----------
  function fillModes() {
    $('#jf-mode').innerHTML = MODES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
    $('#af-presets').innerHTML = CRON_PRESETS.map(([l, c]) => `<button type="button" class="chip" data-cron="${esc(c)}">${esc(l)}</button>`).join('');
  }

  function setKind(kind) {
    for (const r of document.querySelectorAll('input[name="af-kind"]')) r.checked = r.value === kind;
    $('#af-cron-wrap').classList.toggle('hidden', kind !== 'cron');
    $('#af-path-wrap').classList.toggle('hidden', kind === 'cron');
    $('#af-debounce-wrap').classList.toggle('hidden', kind !== 'files');
    $('#af-vars').textContent = kind === 'cron' ? '使える変数: {{date}} {{time}}'
      : kind === 'files' ? '使える変数: {{files}}(変わったファイル){{date}} {{time}}'
        : '使える変数: {{commit}} {{commitMessage}} {{date}} {{time}}';
  }

  function openForm(mode, data = {}) {
    S.mode = mode;
    S.editing = data.id && mode === 'automation' ? data.id : null;
    const t = mode === 'automation' ? (data.template || {}) : data;
    $('#jf-title').textContent = mode === 'job' ? 'ジョブを追加' : (S.editing ? 'オートメーションを編集' : 'オートメーションを追加');
    $('#jf-submit').textContent = mode === 'job' ? 'キューに入れる' : '保存';
    $('#af-part').classList.toggle('hidden', mode !== 'automation');
    $('#jf-name').value = mode === 'automation' ? (data.name || '') : (t.name || '');
    $('#jf-prompt').value = t.prompt || '';
    $('#jf-cwd').value = t.cwd || (mode === 'job' ? (localStorage.getItem('lastJobCwd') || '') : '');
    $('#jf-model').value = t.model || '';
    $('#jf-mode').value = t.permissionMode || '';
    $('#jf-tools').value = (t.allowedTools || []).join('\n');
    $('#jf-budget').value = t.maxBudgetUsd || '';
    $('#jf-priority').value = t.priority || 'normal';
    $('#jf-worktree').checked = !!t.worktree;
    $('#jf-mcp').innerHTML = window.ToolsView.pickerHtml(Array.isArray(t.mcpServers) ? t.mcpServers : null);
    $('#af-cron').value = data.cron || '0 9 * * 1-5';
    $('#af-path').value = data.watchPath || '';
    $('#af-debounce').value = data.debounceSec || 10;
    $('#af-skip').checked = data.skipIfRunning !== false;
    setKind(data.kind || 'cron');
    $('#jf-error').classList.add('hidden');
    $('#dlg-job').showModal();
    $(mode === 'automation' && !S.editing ? '#jf-name' : '#jf-prompt').focus();
  }

  function formTemplate() {
    return {
      prompt: $('#jf-prompt').value,
      cwd: $('#jf-cwd').value.trim(),
      model: $('#jf-model').value.trim(),
      permissionMode: $('#jf-mode').value,
      allowedTools: $('#jf-tools').value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean),
      maxBudgetUsd: $('#jf-budget').value.trim(),
      priority: $('#jf-priority').value,
      worktree: $('#jf-worktree').checked,
      mcpServers: window.ToolsView.pickerValue($('#jf-mcp')),
    };
  }

  async function submitForm(e) {
    e.preventDefault();
    const t = formTemplate();
    try {
      if (S.mode === 'job') {
        const j = await api('POST', '/api/jobs', { ...t, name: $('#jf-name').value.trim() });
        S.jobs.set(j.id, j);
        try { localStorage.setItem('lastJobCwd', t.cwd); } catch (_) { /* ignore */ }
        renderJobs();
      } else {
        const body = {
          name: $('#jf-name').value.trim(),
          kind: document.querySelector('input[name="af-kind"]:checked').value,
          cron: $('#af-cron').value.trim(),
          watchPath: $('#af-path').value.trim(),
          debounceSec: Number($('#af-debounce').value) || 10,
          skipIfRunning: $('#af-skip').checked,
          template: t,
        };
        const a = S.editing ? await api('PUT', `/api/automations/${S.editing}`, body) : await api('POST', '/api/automations', body);
        S.autos.set(a.id, a);
        renderAutos();
      }
      $('#dlg-job').close();
    } catch (err) {
      $('#jf-error').textContent = err.message;
      $('#jf-error').classList.remove('hidden');
    }
  }

  // ---------- 操作 ----------
  async function onJobAction(id, act) {
    const j = S.jobs.get(id);
    try {
      if (act === 'cancel') await api('POST', `/api/jobs/${id}/cancel`);
      else if (act === 'retry') { const n = await api('POST', `/api/jobs/${id}/retry`); S.jobs.set(n.id, n); renderJobs(); }
      else if (act === 'remove') { await api('DELETE', `/api/jobs/${id}`); S.jobs.delete(id); renderJobs(); }
      else if (act === 'open') { const s = await api('POST', `/api/jobs/${id}/open`); if (S.opts.onOpenSession) S.opts.onOpenSession(s); }
      else if (act === 'diff') window.DiffView.open(id);
      else if (act === 'edit-copy' && j) openForm('job', { ...j, name: `${j.name} のコピー` });
    } catch (e) { alert(e.message); }
  }

  async function onAutoAction(id, act, el) {
    const a = S.autos.get(id);
    if (!a) return;
    try {
      if (act === 'toggle') { const n = await api('PUT', `/api/automations/${id}`, { enabled: el.checked }); S.autos.set(id, n); renderAutos(); }
      else if (act === 'run') { const j = await api('POST', `/api/automations/${id}/run`); if (j) { S.jobs.set(j.id, j); renderJobs(); } }
      else if (act === 'edit') openForm('automation', a);
      else if (act === 'remove') {
        if (!confirm(`オートメーション「${a.name}」を削除しますか?`)) return;
        await api('DELETE', `/api/automations/${id}`);
        S.autos.delete(id);
        renderAutos();
      }
    } catch (e) { alert(e.message); if (act === 'toggle') el.checked = !el.checked; }
  }

  function bind() {
    fillModes();
    $('#jobs-add').addEventListener('click', () => openForm('job'));
    $('#autos-add').addEventListener('click', () => openForm('automation'));
    $('#jf-form').addEventListener('submit', submitForm);
    $('#jf-cancel').addEventListener('click', () => $('#dlg-job').close());
    for (const r of document.querySelectorAll('input[name="af-kind"]')) r.addEventListener('change', () => setKind(r.value));
    $('#af-presets').addEventListener('click', (e) => { const b = e.target.closest('[data-cron]'); if (b) $('#af-cron').value = b.dataset.cron; });
    $('#jobs-max').addEventListener('change', async (e) => {
      try { await api('PUT', '/api/settings', { maxConcurrentJobs: Number(e.target.value) }); } catch (err) { alert(err.message); }
    });
    $('#jobs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-jact]');
      const row = e.target.closest('[data-job]');
      if (b && row) { onJobAction(row.dataset.job, b.dataset.jact); return; }
      if (row && !e.target.closest('button')) { openDetail(row.dataset.job); return; }
      const ab = e.target.closest('[data-aact]');
      const card = e.target.closest('[data-auto]');
      if (ab && card && ab.dataset.aact !== 'toggle') onAutoAction(card.dataset.auto, ab.dataset.aact, ab);
    });
    $('#jobs').addEventListener('change', (e) => {
      const ab = e.target.closest('[data-aact="toggle"]');
      if (ab) onAutoAction(e.target.closest('[data-auto]').dataset.auto, 'toggle', ab);
    });
    $('#jd-close').addEventListener('click', () => $('#dlg-jobdetail').close());
    $('#jd-diff').addEventListener('click', () => { if (S.detail) window.DiffView.open(S.detail); });
    $('#dlg-jobdetail').addEventListener('close', () => { S.detail = null; });
    $('#jd-copy').addEventListener('click', () => {
      const j = S.jobs.get(S.detail);
      if (!j) return;
      $('#dlg-jobdetail').close();
      openForm('job', { ...j, name: `${j.name} のコピー` });
    });
    setInterval(tick, 1000);
    setInterval(() => { if (S.detail && S.jobs.get(S.detail)?.status === 'running') refreshTranscript(); }, 2000);
  }

  window.JobsView = {
    async init(opts) {
      S.opts = opts || {};
      bind();
      await this.resync();
    },
    async resync() {
      try {
        const [d, autos] = await Promise.all([api('GET', '/api/jobs'), api('GET', '/api/automations')]);
        S.jobs = new Map(d.jobs.map((j) => [j.id, j]));
        S.autos = new Map(autos.map((a) => [a.id, a]));
        S.max = d.maxConcurrent;
        S.command = d.command;
        $('#jobs-max').value = String(S.max);
        $('#jobs-cmd').textContent = `${S.command} -p`;
        renderJobs();
        renderAutos();
      } catch (e) { console.error(e); }
    },
    onJob(j) {
      const prev = S.jobs.get(j.id);
      S.jobs.set(j.id, j);
      renderJobs();
      if (S.detail === j.id && (!prev || prev.status !== j.status || j.status === 'running')) refreshTranscript();
    },
    onJobRemoved(id) { S.jobs.delete(id); renderJobs(); },
    onAutomation(a) { S.autos.set(a.id, a); renderAutos(); renderJobs(); },
    onAutomationRemoved(id) { S.autos.delete(id); renderAutos(); },
    onSettings(st) { if (st.maxConcurrentJobs) $('#jobs-max').value = String(st.maxConcurrentJobs); },
    get: (id) => S.jobs.get(id),
    newJob: (prefill) => openForm('job', prefill || {}),
  };
})();
