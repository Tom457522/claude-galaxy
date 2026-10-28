'use strict';
// 管理 → 設定 / 診断 / 検索 の画面と、はじめのガイド

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => UI.esc(s);

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

  const S = { opts: {}, settings: {}, budget: null };
  const fmtUsd = (v) => `$${(v || 0).toFixed(2)}`;

  // ---------- 設定 ----------
  async function put(patch) {
    try {
      S.settings = await api('PUT', '/api/settings', patch);
      fill(S.settings);
    } catch (e) { UI.toast(e.message, { type: 'error' }); }
  }

  function fill(st) {
    S.settings = st;
    const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
    const chk = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
    set('#st-daily', st.budgetDailyUsd || 0);
    set('#st-job', st.budgetJobUsd || 0);
    set('#st-sess', st.budgetSessionWarnUsd || 0);
    set('#st-pl-sess', st.planLimitSessionPct || 0);
    set('#st-pl-week', st.planLimitWeeklyPct || 0);
    set('#st-pl-price', st.planMonthlyUsd || 0);
    set('#st-pl-margin', st.planPaceMargin || 10);
    chk('#st-pl-pace', st.planPaceGuard);
    chk('#st-cloud', st.budgetIncludeCloud !== false);
    chk('#st-notify', st.notifyDesktop !== false);
    chk('#st-inbox', st.permissionInbox);
    chk('#st-gate', st.approvalGate);
    set('#st-gate-pats', (st.approvalPatterns || []).join('\n'));
    chk('#st-safety', st.collectSafetyEvents);
    set('#st-max', String(st.maxConcurrentJobs || 2));
    set('#st-dmodel', st.dispatchModel || 'haiku');
    set('#st-wtdir', st.worktreeDir || '');
    chk('#st-bus', st.busEnabled !== false);
    chk('#st-audit', st.auditEnabled !== false);
    set('#st-audit-days', String(st.auditDays || 30));
    UI.setNotifyEnabled(st.notifyDesktop !== false);
    notifyState();
  }

  function notifyState() {
    const el = $('#st-notify-state');
    if (typeof Notification === 'undefined') { el.textContent = 'このブラウザは通知に対応していません'; return; }
    el.textContent = { granted: 'ブラウザの許可: あり', denied: 'ブラウザの許可: 拒否(ブラウザのサイト設定から変更してください)', default: 'ブラウザの許可: まだ' }[Notification.permission];
    $('#st-notify-perm').classList.toggle('hidden', Notification.permission !== 'default');
  }

  function renderBudget(b) {
    S.budget = b;
    if (!b) return;
    $('#st-spent').textContent = `今日 ${fmtUsd(b.spent)}${b.limit ? ` / 上限 ${fmtUsd(b.limit)}` : ''}(ジョブ ${fmtUsd(b.jobs)}・セッション ${fmtUsd(b.sessions)}${b.cloud ? `・クラウド ${fmtUsd(b.cloud)}` : ''})`;
    $('#st-spent').className = b.over ? 'over' : b.warn ? 'warn' : '';
    const max = Math.max(b.limit || 0, ...b.history.map((h) => h.spent), 0.01);
    $('#st-bars').innerHTML = b.history.length ? b.history.map((h) => {
      const pct = Math.max(2, Math.round((h.spent / max) * 100));
      const over = b.limit && h.spent >= b.limit;
      return `<div class="st-bar${over ? ' over' : ''}" title="${esc(h.day)}: ${fmtUsd(h.spent)}"><i style="height:${pct}%"></i><small>${esc(h.day.slice(5))}</small></div>`;
    }).join('') : '<p class="g-note">まだ記録がありません</p>';
  }

  function bindSettings() {
    const num = (id, key) => $(id).addEventListener('change', (e) => put({ [key]: Number(e.target.value) || 0 }));
    num('#st-daily', 'budgetDailyUsd');
    num('#st-job', 'budgetJobUsd');
    num('#st-sess', 'budgetSessionWarnUsd');
    num('#st-pl-sess', 'planLimitSessionPct');
    num('#st-pl-week', 'planLimitWeeklyPct');
    num('#st-pl-price', 'planMonthlyUsd');
    num('#st-pl-margin', 'planPaceMargin');
    const bool = (id, key) => $(id).addEventListener('change', (e) => put({ [key]: e.target.checked }));
    bool('#st-notify', 'notifyDesktop');
    bool('#st-inbox', 'permissionInbox');
    bool('#st-gate', 'approvalGate');
    bool('#st-safety', 'collectSafetyEvents');
    $('#st-gate-pats').addEventListener('change', (e) => put({ approvalPatterns: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) }));
    bool('#st-pl-pace', 'planPaceGuard');
    bool('#st-cloud', 'budgetIncludeCloud');
    bool('#st-bus', 'busEnabled');
    bool('#st-audit', 'auditEnabled');
    $('#st-max').addEventListener('change', (e) => put({ maxConcurrentJobs: Number(e.target.value) }));
    $('#st-audit-days').addEventListener('change', (e) => put({ auditDays: Number(e.target.value) }));
    $('#st-dmodel').addEventListener('change', (e) => put({ dispatchModel: e.target.value }));
    $('#st-wtdir').addEventListener('change', (e) => put({ worktreeDir: e.target.value }));
    $('#st-notify-perm').addEventListener('click', async () => { await UI.requestNotify(); notifyState(); });
    $('#st-notify-test').addEventListener('click', async () => {
      const p = await UI.requestNotify();
      notifyState();
      if (p !== 'granted') { UI.toast('ブラウザで通知が許可されていません', { type: 'error' }); return; }
      // 画面を見ているときは出さない決まりなので、試すときは直接出す
      try { new Notification('Claude Galaxy', { body: '通知はこのように表示されます' }); } catch (e) { UI.toast(e.message, { type: 'error' }); }
    });
    try { $('#st-theme').value = localStorage.getItem('theme') || 'auto'; } catch (_) { /* ignore */ }
    $('#st-theme').addEventListener('change', (e) => UI.setTheme(e.target.value));
    $('#st-guide').addEventListener('click', () => openGuide());
    $('#st-restore').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      let bundle;
      try { bundle = JSON.parse(await f.text()); } catch (_) { UI.toast('JSON として読めません', { type: 'error' }); return; }
      const names = Object.keys((bundle && bundle.files) || {});
      if (!await UI.confirm(`このバックアップ(${bundle.createdAt || '日時不明'})で、次のファイルを置き換えます:\n${names.join(', ')}\n\n次にサーバーを起動したときに反映します(いまのファイルは .bak として残ります)。`, { ok: '復元を予約する', danger: true })) return;
      try {
        const r = await api('POST', '/api/restore', { bundle });
        $('#st-restore-note').textContent = r.note;
        UI.toast(r.note, { timeout: 10000 });
      } catch (err) { UI.toast(err.message, { type: 'error' }); }
    });
    api('GET', '/api/restore').then((r) => {
      if (r.pending.length) $('#st-restore-note').textContent = `復元を予約しています(${r.pending.join(', ')})。サーバーを再起動すると反映します。`;
    }).catch(() => {});
    for (const a of document.querySelectorAll('.go-settings')) {
      a.addEventListener('click', (e) => { e.preventDefault(); S.opts.go('settings'); });
    }
  }

  // ---------- 診断 ----------
  const ICON = { ok: '✓', warn: '!', fail: '✕' };
  async function runDoctor() {
    const btn = $('#dr-run');
    btn.disabled = true;
    btn.textContent = '診断中…';
    $('#dr-list').innerHTML = '<p class="jobs-empty">確かめています…(claude の起動確認に少しかかります)</p>';
    try {
      const d = await api('GET', '/api/doctor');
      $('#dr-list').innerHTML = `<p class="dr-sum ${d.ok ? 'ok' : 'fail'}">${d.ok ? '✓ 問題は見つかりませんでした' : '✕ 直したほうがよい項目があります'}</p>` +
        d.results.map((r) => `<div class="dr-row dr-${r.status}"><span class="dr-ic">${ICON[r.status]}</span>` +
          `<b>${esc(r.label)}</b><span class="dr-detail">${esc(r.detail)}</span>${r.hint ? `<span class="dr-hint">${esc(r.hint)}</span>` : ''}</div>`).join('');
      if (S.opts.onDoctor) S.opts.onDoctor(d);
    } catch (e) {
      $('#dr-list').innerHTML = `<p class="error">${esc(e.message)}</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'もう一度診断する';
    }
  }

  // ---------- 検索 ----------
  const KIND = { session: 'セッション', job: 'ジョブ', message: 'メッセージ', memory: '共有メモリ' };
  async function runSearch(q) {
    const query = (q ?? $('#sr-q').value).trim();
    $('#sr-q').value = query;
    if (!query) return;
    $('#sr-list').innerHTML = '<p class="jobs-empty">探しています…</p>';
    try {
      const hits = await api('GET', `/api/search?q=${encodeURIComponent(query)}`);
      $('#sr-count').textContent = `${hits.length} 件${hits.length >= 200 ? '(多いため 200 件まで)' : ''}`;
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const mark = (t) => {
        let h = esc(t);
        for (const w of words) h = h.replace(new RegExp(esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`);
        return h;
      };
      $('#sr-list').innerHTML = hits.length ? hits.map((h) => `<div class="sr-row" data-kind="${esc(h.kind)}" data-id="${esc(h.id)}">` +
        `<span class="mem-tag">${KIND[h.kind]}</span><b>${esc(h.name)}</b><small>${esc(h.kind === 'memory' ? '' : h.id)}</small>` +
        `<div class="sr-snip">${mark(h.snippet)}</div></div>`).join('') : '<p class="jobs-empty">見つかりませんでした</p>';
    } catch (e) { $('#sr-list').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  }

  // ---------- はじめのガイド ----------
  function openGuide() { $('#dlg-guide').showModal(); }

  function bindGuide() {
    $('#dlg-guide').addEventListener('click', (e) => {
      const b = e.target.closest('[data-guide]');
      if (!b) return;
      const k = b.dataset.guide;
      $('#dlg-guide').close();
      try { localStorage.setItem('guided', '1'); } catch (_) { /* ignore */ }
      if (k === 'roots') S.opts.openRoots();
      else if (k === 'session') S.opts.newSession();
      else if (k === 'doctor') { S.opts.go('doctor'); runDoctor(); }
    });
  }

  window.SettingsView = {
    async init(opts) {
      S.opts = opts;
      bindSettings();
      bindGuide();
      $('#dr-run').addEventListener('click', runDoctor);
      $('#sr-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
      $('#sr-list').addEventListener('click', (e) => {
        const r = e.target.closest('.sr-row');
        if (r) S.opts.openHit(r.dataset.kind, r.dataset.id);
      });
      try { fill(await api('GET', '/api/settings')); } catch (_) { /* ignore */ }
      try { renderBudget(await api('GET', '/api/budget')); } catch (_) { /* ignore */ }
      api('GET', '/api/plan').then((p) => window.SettingsView.onPlan(p), () => { /* ignore */ });
      let guided = false;
      try { guided = localStorage.getItem('guided') === '1'; } catch (_) { guided = true; }
      if (!guided) openGuide();
    },
    onSettings: fill,
    onBudget: renderBudget,
    // プランの利用率(使用量タブと同じもの)を見出しに出す
    onPlan(p) {
      const el = $('#st-plan');
      if (!el || !p) return;
      el.textContent = p.ok ? `${p.plan ? `${p.plan.name} · ` : ''}${p.limits.map((l) => `${l.label} ${Math.round(l.percent)}%`).join(' · ')}` : p.error || '';
      el.className = p.limits.some((l) => l.reason) ? 'over' : p.limits.some((l) => l.percent >= l.threshold - 10) ? 'warn' : '';
    },
    budget: () => S.budget,
    runDoctor,
    search: runSearch,
    openGuide,
  };
})();
