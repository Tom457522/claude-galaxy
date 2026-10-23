'use strict';
// ツールタブ: Galaxy が管理する MCP サーバー(登録・接続確認・既定で使うか)、
// Claude Code 自身の MCP 設定と skills / agents / commands の一覧、worktree と窓口の設定

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

  const SCOPE = { user: 'ユーザー', local: 'このフォルダ(ローカル)', project: 'プロジェクト(.mcp.json)' };
  const EXT = { skill: 'スキル', agent: 'サブエージェント', command: 'コマンド' };
  const S = { servers: [], claude: [], ext: [], cwd: '', editing: null, checking: new Set(), loaded: false };

  const fmtTime = (t) => new Date(t).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  function serverCard(s) {
    const c = s.lastCheck;
    const st = S.checking.has(s.id) ? '<span class="tl-st">確認中…</span>'
      : !c ? '<span class="tl-st">未確認</span>'
        : c.ok ? `<span class="tl-st ok">✓ 接続できます(${c.ms}ms・ツール ${(c.tools || []).length} 個)</span>`
          : `<span class="tl-st ng">✕ ${esc(c.error || '失敗')}</span>`;
    const target = s.type === 'stdio' ? [s.command, ...s.args].join(' ') : s.url;
    return `<div class="tl-card" data-srv="${esc(s.id)}">` +
      `<div class="auto-head"><b>${esc(s.name)}</b><span class="auto-kind">${esc(s.type)}</span></div>` +
      `<div class="auto-when"><code>${esc(target)}</code></div>` +
      (s.desc ? `<div class="auto-prompt">${esc(s.desc)}</div>` : '') +
      (Object.keys(s.env).length ? `<div class="auto-last">env: ${esc(Object.keys(s.env).join(', '))}</div>` : '') +
      (Object.keys(s.headers).length ? `<div class="auto-last">headers: ${esc(Object.keys(s.headers).join(', '))}</div>` : '') +
      `<div class="auto-last">${st}${c ? `  ${fmtTime(c.at)}` : ''}</div>` +
      (c && c.ok && c.tools && c.tools.length ? `<div class="tl-tools">${c.tools.slice(0, 40).map((t) => `<span class="mem-tag">${esc(t)}</span>`).join('')}</div>` : '') +
      '<div class="auto-acts">' +
        `<label class="g-chk" title="新しいセッション・ジョブで、最初から選ばれた状態にする"><input type="checkbox" data-sact="default" ${s.defaultOn ? 'checked' : ''}> 既定で使う</label>` +
        '<button class="btn" data-sact="check">接続確認</button><button class="btn" data-sact="edit">編集</button>' +
        '<button class="icon-btn" data-sact="remove" title="削除">✕</button>' +
      '</div></div>';
  }

  function render() {
    $('#tl-servers').innerHTML = S.servers.length ? S.servers.map(serverCard).join('')
      : '<p class="jobs-empty">まだありません。ここに登録した MCP サーバーを、セッション・ジョブごとに選んで渡せます(Claude Code の設定ファイルは書き換えません)。</p>';
    $('#tl-claude').innerHTML = S.claude.length ? S.claude.map((c) => `<div class="tl-row"><b>${esc(c.name)}</b><span class="mem-tag">${esc(SCOPE[c.scope] || c.scope)}</span>` +
      `<span class="mem-tag">${esc(c.type)}</span><code>${esc(c.target || '')}</code><small>${esc(c.source)}</small></div>`).join('')
      : '<p class="jobs-empty">設定ファイルに MCP サーバーは見つかりませんでした</p>';
    const groups = ['skill', 'agent', 'command'].map((k) => {
      const items = S.ext.filter((e) => e.kind === k);
      return `<div class="tl-group"><div class="tl-glbl">${EXT[k]} <small>${items.length}</small></div>` +
        (items.length ? items.map((e) => `<div class="tl-row" title="${esc(e.file)}"><b>${esc(e.name)}</b><span class="mem-tag">${e.scope === 'user' ? 'ユーザー' : 'プロジェクト'}</span><span class="tl-desc">${esc(e.description)}</span></div>`).join('')
          : '<p class="jobs-empty">なし</p>') + '</div>';
    });
    $('#tl-ext').innerHTML = groups.join('');
  }

  async function load() {
    const cwd = $('#tl-cwd').value.trim();
    try {
      const d = await api('GET', `/api/tools${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`);
      S.servers = d.servers;
      S.claude = d.claudeServers;
      S.ext = d.extensions;
      S.loaded = true;
      render();
      notify();
    } catch (e) { console.error(e); }
  }

  const listeners = new Set();
  function notify() { for (const fn of listeners) fn(S.servers); }

  // ---------- 追加 / 編集 ----------
  function setType(t) {
    for (const r of document.querySelectorAll('input[name="ms-type"]')) r.checked = r.value === t;
    $('#ms-stdio').classList.toggle('hidden', t !== 'stdio');
    $('#ms-http').classList.toggle('hidden', t === 'stdio');
  }

  function openForm(s = null) {
    S.editing = s ? s.id : null;
    $('#ms-title').textContent = s ? 'MCP サーバーを編集' : 'MCP サーバーを追加';
    $('#ms-name').value = s ? s.name : '';
    $('#ms-desc').value = s ? s.desc : '';
    $('#ms-command').value = s ? s.command : '';
    $('#ms-args').value = s ? s.args.join('\n') : '';
    $('#ms-env').value = s ? Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join('\n') : '';
    $('#ms-url').value = s ? s.url : '';
    $('#ms-headers').value = s ? Object.entries(s.headers).map(([k, v]) => `${k}: ${v}`).join('\n') : '';
    $('#ms-default').checked = s ? s.defaultOn : false;
    setType(s ? s.type : 'stdio');
    $('#ms-error').classList.add('hidden');
    $('#dlg-mcp').showModal();
    $('#ms-name').focus();
  }

  async function submit(e) {
    e.preventDefault();
    const body = {
      name: $('#ms-name').value.trim(),
      desc: $('#ms-desc').value.trim(),
      type: document.querySelector('input[name="ms-type"]:checked').value,
      command: $('#ms-command').value.trim(),
      args: $('#ms-args').value,
      env: $('#ms-env').value,
      url: $('#ms-url').value.trim(),
      headers: $('#ms-headers').value,
      defaultOn: $('#ms-default').checked,
    };
    try {
      const s = S.editing ? await api('PUT', `/api/tools/servers/${S.editing}`, body) : await api('POST', '/api/tools/servers', body);
      $('#dlg-mcp').close();
      await load();
      check(s.id);
    } catch (err) {
      $('#ms-error').textContent = err.message;
      $('#ms-error').classList.remove('hidden');
    }
  }

  async function check(id) {
    S.checking.add(id);
    render();
    try {
      const s = await api('POST', `/api/tools/servers/${id}/check`);
      S.servers = S.servers.map((x) => (x.id === id ? s : x));
    } catch (e) { alert(e.message); }
    S.checking.delete(id);
    render();
  }

  async function onAction(id, act, el) {
    const s = S.servers.find((x) => x.id === id);
    if (!s) return;
    try {
      if (act === 'check') check(id);
      else if (act === 'edit') openForm(s);
      else if (act === 'default') { await api('PUT', `/api/tools/servers/${id}`, { defaultOn: el.checked }); load(); }
      else if (act === 'remove') {
        if (!confirm(`「${s.name}」を削除しますか?`)) return;
        await api('DELETE', `/api/tools/servers/${id}`);
        load();
      }
    } catch (e) { alert(e.message); }
  }

  function bind() {
    $('#tl-add').addEventListener('click', () => openForm());
    $('#ms-form').addEventListener('submit', submit);
    $('#ms-cancel').addEventListener('click', () => $('#dlg-mcp').close());
    for (const r of document.querySelectorAll('input[name="ms-type"]')) r.addEventListener('change', () => setType(r.value));
    $('#tl-servers').addEventListener('click', (e) => {
      const b = e.target.closest('[data-sact]');
      const card = e.target.closest('[data-srv]');
      if (b && card && b.dataset.sact !== 'default') onAction(card.dataset.srv, b.dataset.sact, b);
    });
    $('#tl-servers').addEventListener('change', (e) => {
      const b = e.target.closest('[data-sact="default"]');
      if (b) onAction(e.target.closest('[data-srv]').dataset.srv, 'default', b);
    });
    $('#tl-cwd-go').addEventListener('click', load);
    $('#tl-cwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
    $('#tl-mcplist').addEventListener('click', async () => {
      const outEl = $('#tl-mcplist-out');
      outEl.classList.remove('hidden');
      outEl.textContent = 'claude mcp list を実行中…(接続確認のため少し時間がかかります)';
      try {
        const r = await api('POST', '/api/tools/claude-mcp-list', { cwd: $('#tl-cwd').value.trim() });
        outEl.textContent = `$ claude mcp list   (${r.cwd})\n${r.output || '(出力なし)'}`;
      } catch (e) { outEl.textContent = e.message; }
    });
    $('#tl-wtdir').addEventListener('change', async (e) => {
      try { await api('PUT', '/api/settings', { worktreeDir: e.target.value }); } catch (err) { alert(err.message); }
    });
    $('#tl-dmodel').addEventListener('change', async (e) => {
      try { await api('PUT', '/api/settings', { dispatchModel: e.target.value }); } catch (err) { alert(err.message); }
    });
  }

  // セッション / ジョブのダイアログに置く「使う MCP サーバー」のチェックボックス
  function pickerHtml(selected) {
    if (!S.servers.length) return '<span class="g-note">(ツールタブで MCP サーバーを登録すると、ここで選べます)</span>';
    return S.servers.map((s) => {
      const on = selected ? selected.includes(s.id) : s.defaultOn;
      return `<label class="g-chk"><input type="checkbox" value="${esc(s.id)}" ${on ? 'checked' : ''}> ${esc(s.name)}</label>`;
    }).join('');
  }
  const pickerValue = (el) => [...el.querySelectorAll('input[type="checkbox"]')].filter((c) => c.checked).map((c) => c.value);

  window.ToolsView = {
    async init() { bind(); await load(); },
    show() { load(); },
    onSettings(st) {
      if (document.activeElement !== $('#tl-wtdir')) $('#tl-wtdir').value = st.worktreeDir || '';
      if (document.activeElement !== $('#tl-dmodel')) $('#tl-dmodel').value = st.dispatchModel || 'haiku';
    },
    servers: () => S.servers,
    onServers: (fn) => listeners.add(fn),
    pickerHtml,
    pickerValue,
  };
})();
