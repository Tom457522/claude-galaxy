'use strict';
// ボード: エージェント同士・あなたとのメッセージと、共有メモリ(MCP の memory_* で読み書きされる知識)
//   共有メモリの重要度・期限・確認済み、エージェントの候補(memory_propose)の承認、点検、棚卸し、最初に渡す内容のプレビュー

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const S = { messages: [], memory: [], candidates: [], lint: [], memoryLearn: false, memoryExport: null, agents: [], unread: 0, opts: {}, visible: false, query: '', open: new Set(), timer: null };

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
        `<div class="bm-text">${UI.markdown(m.text)}</div></div>`;
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

  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  function badges(m) {
    const out = [];
    if (m.priority === 'must') out.push('<span class="mem-badge must" title="最初に渡すとき先に入れます">必須</span>');
    out.push(m.verified ? '<span class="mem-badge ok">確認済み</span>' : '<span class="mem-badge" title="エージェントが書いたか、まだ確かめていない項目です">未確認</span>');
    if (m.expires) {
      const past = m.expires < todayStr();
      out.push(`<span class="mem-badge${past ? ' warn' : ''}" title="${past ? '期限切れのため、最初に渡す内容から外します' : 'この日を過ぎると最初に渡す内容から外します'}">${past ? '期限切れ ' : ''}${esc(m.expires)} まで</span>`);
    }
    return out.join('');
  }

  function renderMemory() {
    const words = S.query.toLowerCase().split(/\s+/).filter(Boolean);
    const list = S.memory.filter((m) => {
      const hay = `${m.key}\n${m.value}\n${(m.tags || []).join(' ')}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    const today = todayStr();
    $('#mem-count').textContent = `${list.length} / ${S.memory.length} 件`;
    $('#mem-list').innerHTML = list.length ? list.map((m) => {
      const open = S.open.has(m.key);
      return `<div class="mem${open ? ' open' : ''}${m.expires && m.expires < today ? ' expired' : ''}" data-key="${esc(m.key)}">` +
        `<div class="mem-head"><b class="mem-key">${esc(m.key)}</b>${badges(m)}${(m.tags || []).map((t) => `<span class="mem-tag">${esc(t)}</span>`).join('')}` +
        `<span class="mem-by">${esc(m.author || '')} · ${fmtTime(m.updatedAt)}</span>` +
        (m.verified ? '' : '<button class="icon-btn" data-mact="verify" title="確認済みにする">✓</button>') +
        '<button class="icon-btn" data-mact="edit" title="編集">✎</button><button class="icon-btn" data-mact="del" title="削除">✕</button></div>' +
        `<div class="mem-val">${esc(open ? m.value : m.value.slice(0, 240) + (m.value.length > 240 ? '…' : ''))}</div></div>`;
    }).join('') : `<p class="jobs-empty">${S.memory.length ? '一致するものはありません' : 'エージェントは MCP ツール memory_write で書き込みます。ここから書くこともできます。'}</p>`;
    renderCandidates();
    renderLint();
    $('#mem-learn').checked = !!S.memoryLearn;
    renderExport();
  }

  function renderExport() {
    const x = S.memoryExport;
    const el = $('#mem-export-state');
    if (!x || x.mode === 'off' || !x.vault) { el.textContent = 'Vault への書き出しはオフです(設定 → 共有メモリの書き出し)'; return; }
    const l = x.last;
    const head = `書き出し先: ${x.vault}(${x.mode === 'push' ? 'コミットして push' : 'ファイルだけ'}${x.auto ? '・自動' : ''}${x.pending ? '・予約あり' : ''})`;
    if (!l) { el.textContent = `${head}。まだ書き出していません`; return; }
    const when = fmtTime(l.at);
    el.innerHTML = esc(head) + '<br>' + (l.ok
      ? esc(`${when} に ${l.exported} 件を書き出しました(書いた ${l.written}・消した ${l.removed}${l.pushed ? '・push 済み' : l.committed ? '・コミット済み' : ''})`) +
        (l.blocked && l.blocked.length ? `<br>書き出さなかったもの: ${l.blocked.map((b) => esc(`${b.key}(${b.reason})`)).join('、')}` : '')
      : `<span class="error">${esc(`${when} の書き出しに失敗しました: ${l.error}`)}</span>`);
  }

  function renderCandidates() {
    const box = $('#mem-cands');
    box.classList.toggle('hidden', !S.candidates.length);
    if (!S.candidates.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<h4>承認待ちの候補 ${S.candidates.length} 件</h4>` + S.candidates.map((c) => {
      const what = c.action === 'delete' ? '削除' : (c.current === null ? '新規' : '書き換え');
      return `<div class="mem-cand" data-cid="${esc(c.id)}">` +
        `<div class="mem-head"><span class="mem-badge${c.action === 'delete' ? ' warn' : ''}">${what}</span><b class="mem-key">${esc(c.key)}</b>` +
        `<span class="mem-by">${esc(c.author || '')} · ${fmtTime(c.at)}</span></div>` +
        (c.reason ? `<div class="mem-cand-reason">理由: ${esc(c.reason)}</div>` : '') +
        (c.action === 'write' ? `${c.current !== null ? `<details><summary>いまの本文</summary><pre>${esc(c.current)}</pre></details>` : ''}<pre>${esc(c.value)}</pre>` : '') +
        '<div class="dlg-actions">' +
        (c.action === 'write' ? '<button type="button" class="btn" data-cact="edit" title="下のフォームに読み込み、直してから書き込みます(候補は消えます)">直して入れる</button>' : '') +
        '<button type="button" class="btn" data-cact="reject">却下</button><button type="button" class="btn primary" data-cact="approve">承認</button></div></div>';
    }).join('');
  }

  const LINT_LABEL = { expired: '期限切れ', 'must-unverified': '未確認の必須', large: '長すぎ', stale: '古い', duplicate: '重複' };
  function renderLint() {
    const el = $('#mem-lint');
    el.classList.toggle('hidden', !S.lint.length);
    el.querySelector('summary').textContent = `点検: 見直すとよい項目 ${S.lint.length} 件`;
    el.querySelector('ul').innerHTML = S.lint.map((i) => `<li>[${esc(LINT_LABEL[i.kind] || i.kind)}] ` +
      `${i.keys.map((k) => `<a data-lkey="${esc(k)}">${esc(k)}</a>`).join('、')} — ${esc(i.text)}</li>`).join('');
  }

  function fillForm(m) {
    $('#mf-key').value = m.key;
    $('#mf-value').value = m.value;
    $('#mf-tags').value = (m.tags || []).join(', ');
    $('#mf-priority').value = m.priority === 'must' ? 'must' : 'normal';
    $('#mf-expires').value = m.expires || '';
    $('#mf-verified').checked = true;
    $('#mf-value').focus();
  }

  // 新規セッション・ジョブ・窓口の「共有メモリから最初に渡す」のプレビュー
  async function preview(inputId) {
    const out = document.getElementById(`${inputId}-pv`);
    const q = document.getElementById(inputId).value.trim();
    out.classList.remove('hidden');
    try {
      const r = await api('POST', '/api/board/memory/preview', { query: q });
      if (!r.text) { out.innerHTML = q ? '一致する項目はありません(何も渡しません)' : '指定がないので何も渡しません'; return; }
      const must = r.items.filter((i) => i.priority === 'must').length;
      const ok = r.items.filter((i) => i.verified).length;
      out.innerHTML = `<div>${r.items.length} 件・${(r.bytes / 1024).toFixed(1)} KB(${r.chars} 文字)を渡します。必須 ${must} 件・確認済み ${ok} 件${r.learn ? '。学びを候補として残す指示も足します' : ''}</div>` +
        (r.items.length ? `<ul>${r.items.map((i) => `<li>${esc(i.key)} <small>${i.chars} 文字</small></li>`).join('')}</ul>` : '') +
        (r.expired.length ? `<div>期限切れで外したもの: ${r.expired.map(esc).join('、')}</div>` : '') +
        (r.truncated.length ? `<div>上限(約 30,000 文字)を超えて省いたもの: ${r.truncated.map(esc).join('、')}</div>` : '') +
        `<details><summary>渡す本文を見る</summary><pre>${esc(r.text)}</pre></details>`;
    } catch (e) { out.textContent = e.message; }
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
      S.candidates = d.candidates || [];
      S.lint = d.lint || [];
      S.memoryLearn = !!d.memoryLearn;
      S.memoryExport = d.memoryExport || null;
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
      } catch (err) { UI.toast(err.message, { type: 'error' }); }
    });
    $('#bm-text').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#bm-form').requestSubmit();
    });
    $('#bm-to').addEventListener('change', renderTo);
    $('#bm-clear').addEventListener('click', async () => {
      if (!await UI.confirm('メッセージをすべて消しますか?(共有メモリは消えません)')) return;
      try { await api('DELETE', '/api/board/messages'); load(); } catch (e) { UI.toast(e.message, { type: 'error' }); }
    });
    $('#mem-search').addEventListener('input', (e) => { S.query = e.target.value; renderMemory(); });
    $('#mem-list').addEventListener('click', async (e) => {
      const el = e.target.closest('.mem');
      if (!el) return;
      const key = el.dataset.key;
      const act = e.target.closest('[data-mact]')?.dataset.mact;
      if (act === 'del') {
        if (!await UI.confirm(`「${key}」を削除しますか?`)) return;
        try { await api('DELETE', `/api/board/memory?key=${encodeURIComponent(key)}`); load(); } catch (err) { UI.toast(err.message, { type: 'error' }); }
      } else if (act === 'edit') {
        fillForm(S.memory.find((x) => x.key === key));
      } else if (act === 'verify') {
        try { await api('POST', '/api/board/memory/verify', { key }); load(); } catch (err) { UI.toast(err.message, { type: 'error' }); }
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
          priority: $('#mf-priority').value,
          expires: $('#mf-expires').value,
          verified: $('#mf-verified').checked,
        });
        $('#mf-key').value = ''; $('#mf-value').value = ''; $('#mf-tags').value = '';
        $('#mf-priority').value = 'normal'; $('#mf-expires').value = ''; $('#mf-verified').checked = true;
        load();
      } catch (err) { UI.toast(err.message, { type: 'error' }); }
    });
  }

  function bindMemoryTools() {
    $('#mem-cands').addEventListener('click', async (e) => {
      const el = e.target.closest('.mem-cand');
      const act = e.target.closest('[data-cact]')?.dataset.cact;
      if (!el || !act) return;
      const c = S.candidates.find((x) => x.id === el.dataset.cid);
      if (!c) return;
      try {
        if (act === 'approve') {
          if (c.action === 'delete' && !await UI.confirm(`「${c.key}」を共有メモリから削除しますか?`)) return;
          if (c.action === 'write' && c.value.length > 4000 && !await UI.confirm(`「${c.key}」の候補は ${c.value.length} 文字あります。全文を確かめましたか?(確認済みとして入ります)`)) return;
          await api('POST', `/api/board/candidates/${encodeURIComponent(c.id)}/approve`);
          UI.toast(c.action === 'delete' ? `「${c.key}」を削除しました` : `「${c.key}」に入れました(確認済み)`);
        } else if (act === 'reject') {
          await api('DELETE', `/api/board/candidates/${encodeURIComponent(c.id)}`);
        } else if (act === 'edit') {
          const cur = S.memory.find((x) => x.key === c.key) || {};
          fillForm({ ...cur, key: c.key, value: c.value, tags: c.tags || cur.tags || [] });
          await api('DELETE', `/api/board/candidates/${encodeURIComponent(c.id)}`);
        }
        load();
      } catch (err) { UI.toast(err.message, { type: 'error' }); }
    });
    $('#mem-lint').addEventListener('click', (e) => {
      const a = e.target.closest('[data-lkey]');
      if (!a) return;
      $('#mem-search').value = a.dataset.lkey;
      S.query = a.dataset.lkey;
      S.open.add(a.dataset.lkey);
      renderMemory();
    });
    $('#mem-learn').addEventListener('change', async (e) => {
      try { await api('PUT', '/api/settings', { memoryLearn: e.target.checked }); S.memoryLearn = e.target.checked; } catch (err) { UI.toast(err.message, { type: 'error' }); }
    });
    for (const [id, when] of [['#mem-review-now', 'now'], ['#mem-review-weekly', 'weekly']]) {
      $(id).addEventListener('click', async () => {
        try {
          const r = await api('POST', '/api/board/memory/review', { when });
          UI.toast(r.kind === 'job' ? `棚卸しのジョブ(${r.job.id})を登録しました。終わると候補とメッセージが届きます`
            : r.existed ? '毎週の棚卸しはもう登録されています(ジョブタブのオートメーション)' : '毎週月曜 9 時の棚卸しを登録しました(ジョブタブのオートメーション)');
        } catch (err) { UI.toast(err.message, { type: 'error' }); }
      });
    }
    $('#mem-export').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const r = await api('POST', '/api/board/memory/export');
        UI.toast(`${r.exported} 件を書き出しました${r.pushed ? '(push 済み)' : ''}`);
      } catch (err) { UI.toast(err.message, { type: 'error' }); }
      btn.disabled = false;
      load();
    });
    document.addEventListener('click', (e) => {
      const b = e.target.closest('.mem-preview-btn');
      if (b) preview(b.dataset.for);
    });
  }

  window.BoardView = {
    async init(opts) {
      S.opts = opts || {};
      bind();
      bindMemoryTools();
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
    resync: load,
    searchMemory(q) { $('#mem-search').value = q; S.query = q; load(); },
  };
})();
