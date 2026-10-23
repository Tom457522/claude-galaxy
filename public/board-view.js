'use strict';
// ボード: エージェント同士・あなたとのメッセージと、共有メモリ(MCP の memory_* で読み書きされる知識)

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const S = { messages: [], memory: [], agents: [], unread: 0, opts: {}, visible: false, query: '', open: new Set(), timer: null };

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

  const fmtTime = (t) => new Date(t).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const who = (id, name) => (id === 'user' ? 'あなた' : id === 'all' ? '全員' : `${name || id}`);

  function renderMessages() {
    const box = $('#board-msgs');
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    box.innerHTML = S.messages.length ? S.messages.map((m) => {
      const mine = m.from === 'user';
      const toUser = m.to === 'user';
      const unread = toUser && !m.readAt;
      return `<div class="bm${mine ? ' bm-mine' : ''}${toUser ? ' bm-touser' : ''}${unread ? ' bm-unread' : ''}">` +
        `<div class="bm-head"><b>${esc(who(m.from, m.fromName))}</b><small>${esc(m.from)}</small> → ` +
        `<b>${esc(who(m.to, m.toName))}</b>${m.to !== 'user' && m.to !== 'all' ? `<small>${esc(m.to)}</small>` : ''}` +
        `<span class="bm-time">${fmtTime(m.at)}</span></div>` +
        `<div class="bm-text">${esc(m.text)}</div></div>`;
    }).join('') : '<p class="jobs-empty">メッセージはまだありません。エージェントは MCP ツール send_message で送ります。</p>';
    if (atBottom || !S.rendered) box.scrollTop = box.scrollHeight;
    S.rendered = true;
  }

  function renderTo() {
    const sel = $('#bm-to');
    const cur = sel.value;
    const sessions = S.agents.filter((a) => a.kind === 'session');
    const jobs = S.agents.filter((a) => a.kind === 'job');
    sel.innerHTML = '<option value="all">全員</option>' +
      (sessions.length ? `<optgroup label="対話セッション">${sessions.map((a) => `<option value="${esc(a.id)}">${esc(`${a.name} (${a.id})`)}</option>`).join('')}</optgroup>` : '') +
      (jobs.length ? `<optgroup label="ジョブ">${jobs.map((a) => `<option value="${esc(a.id)}">${esc(`${a.name} (${a.id})`)}</option>`).join('')}</optgroup>` : '');
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
    $('#bm-prompt-wrap').classList.toggle('hidden', !sessions.some((a) => a.id === sel.value));
  }

  function renderMemory() {
    const words = S.query.toLowerCase().split(/\s+/).filter(Boolean);
    const list = S.memory.filter((m) => {
      const hay = `${m.key}\n${m.value}\n${(m.tags || []).join(' ')}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    $('#mem-count').textContent = `${list.length} / ${S.memory.length} 件`;
    $('#mem-list').innerHTML = list.length ? list.map((m) => {
      const open = S.open.has(m.key);
      return `<div class="mem${open ? ' open' : ''}" data-key="${esc(m.key)}">` +
        `<div class="mem-head"><b class="mem-key">${esc(m.key)}</b>${(m.tags || []).map((t) => `<span class="mem-tag">${esc(t)}</span>`).join('')}` +
        `<span class="mem-by">${esc(m.author || '')} · ${fmtTime(m.updatedAt)}</span>` +
        '<button class="icon-btn" data-mact="edit" title="編集">✎</button><button class="icon-btn" data-mact="del" title="削除">✕</button></div>' +
        `<div class="mem-val">${esc(open ? m.value : m.value.slice(0, 240) + (m.value.length > 240 ? '…' : ''))}</div></div>`;
    }).join('') : `<p class="jobs-empty">${S.memory.length ? '一致するものはありません' : 'エージェントは MCP ツール memory_write で書き込みます。ここから書くこともできます。'}</p>`;
  }

  function render() {
    renderMessages();
    renderTo();
    renderMemory();
  }

  async function load() {
    try {
      const d = await api('GET', '/api/board');
      S.messages = d.messages;
      S.memory = d.memory;
      S.agents = d.agents;
      setUnread(d.unreadUser);
      render();
      if (S.visible && S.unread) markRead();
    } catch (e) { console.error(e); }
  }

  function setUnread(n) {
    S.unread = n;
    if (S.opts.onUnread) S.opts.onUnread(n);
  }

  async function markRead() {
    try { await api('POST', '/api/board/read'); } catch (_) { /* ignore */ }
  }

  function bind() {
    $('#bm-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('#bm-text').value.trim();
      if (!text) return;
      try {
        await api('POST', '/api/board/messages', { to: $('#bm-to').value, text, asPrompt: $('#bm-prompt').checked });
        $('#bm-text').value = '';
        load();
      } catch (err) { alert(err.message); }
    });
    $('#bm-text').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#bm-form').requestSubmit();
    });
    $('#bm-to').addEventListener('change', renderTo);
    $('#bm-clear').addEventListener('click', async () => {
      if (!confirm('メッセージをすべて消しますか?(共有メモリは消えません)')) return;
      try { await api('DELETE', '/api/board/messages'); load(); } catch (e) { alert(e.message); }
    });
    $('#mem-search').addEventListener('input', (e) => { S.query = e.target.value; renderMemory(); });
    $('#mem-list').addEventListener('click', async (e) => {
      const el = e.target.closest('.mem');
      if (!el) return;
      const key = el.dataset.key;
      const act = e.target.closest('[data-mact]')?.dataset.mact;
      if (act === 'del') {
        if (!confirm(`「${key}」を削除しますか?`)) return;
        try { await api('DELETE', `/api/board/memory?key=${encodeURIComponent(key)}`); load(); } catch (err) { alert(err.message); }
      } else if (act === 'edit') {
        const m = S.memory.find((x) => x.key === key);
        $('#mf-key').value = m.key;
        $('#mf-value').value = m.value;
        $('#mf-tags').value = (m.tags || []).join(', ');
        $('#mf-value').focus();
      } else {
        if (S.open.has(key)) S.open.delete(key); else S.open.add(key);
        renderMemory();
      }
    });
    $('#mf-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('PUT', '/api/board/memory', {
          key: $('#mf-key').value.trim(),
          value: $('#mf-value').value,
          tags: $('#mf-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
        });
        $('#mf-key').value = ''; $('#mf-value').value = ''; $('#mf-tags').value = '';
        load();
      } catch (err) { alert(err.message); }
    });
    $('#bus-on').addEventListener('change', async (e) => {
      try { await api('PUT', '/api/settings', { busEnabled: e.target.checked }); } catch (err) { alert(err.message); }
    });
  }

  window.BoardView = {
    async init(opts) {
      S.opts = opts || {};
      bind();
      await load();
    },
    show() { S.visible = true; load(); },
    hide() { S.visible = false; },
    // サーバーから「ボードが変わった」と届いたら読み直す(まとめて)
    onChange(d) {
      if (d && typeof d.unreadUser === 'number') setUnread(d.unreadUser);
      clearTimeout(S.timer);
      S.timer = setTimeout(load, S.visible ? 100 : 1500);
    },
    onSettings(st) { $('#bus-on').checked = !!st.busEnabled; },
    resync: load,
  };
})();
