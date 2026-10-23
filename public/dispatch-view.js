'use strict';
// 窓口: 上部の入力欄に「やりたいこと」を書くと、どのフォルダで・どの方法で動かすかの案を作り、
// 確認・修正してから実行する(Ctrl+K / ⌘K で入力欄へ)

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

  const S = { opts: {}, text: '', busy: false };

  // ホーム画面(グラフ)のルート設定を、候補フォルダの起点に使う
  function roots() {
    try {
      const r = JSON.parse(localStorage.getItem('gRoots') || '[]');
      return Array.isArray(r) ? r : [];
    } catch (_) { return []; }
  }

  function setMode(mode) {
    for (const r of document.querySelectorAll('input[name="dp-mode"]')) r.checked = r.value === mode;
    $('#dp-job-part').classList.toggle('hidden', mode !== 'job');
  }

  function fill(plan) {
    setMode(plan.mode);
    $('#dp-cwd').value = plan.cwd || '';
    $('#dp-cands').innerHTML = (plan.candidates || []).map((c) => `<option value="${esc(c.path)}">${esc(`${c.name}${c.git ? ' [git]' : ''}`)}</option>`).join('');
    $('#dp-name').value = plan.name || '';
    $('#dp-prompt').value = plan.prompt || S.text;
    $('#dp-worktree').checked = !!plan.worktree;
    $('#dp-model').value = plan.model || '';
    $('#dp-perm').value = plan.permissionMode || '';
    $('#dp-mcp').innerHTML = window.ToolsView.pickerHtml(null);
    const how = plan.router === 'claude' ? 'Claude が振り分けました' : '簡単な規則で振り分けました';
    $('#dp-reason').textContent = [how, plan.reason, plan.note].filter(Boolean).join('  ・  ');
  }

  async function makePlan(useClaude) {
    const text = $('#cmd-input').value.trim() || S.text;
    if (!text || S.busy) return;
    S.text = text;
    S.busy = true;
    $('#cmd-input').disabled = true;
    $('#cmd-go').textContent = '考え中…';
    $('#dp-error').classList.add('hidden');
    try {
      const plan = await api('POST', '/api/dispatch/plan', { text, roots: roots(), useClaude });
      fill(plan);
      if (!$('#dlg-dispatch').open) $('#dlg-dispatch').showModal();
      $('#dp-run').focus();
    } catch (e) {
      alert(e.message);
    } finally {
      S.busy = false;
      $('#cmd-input').disabled = false;
      $('#cmd-go').textContent = '➤';
    }
  }

  async function run(e) {
    e.preventDefault();
    const mode = document.querySelector('input[name="dp-mode"]:checked').value;
    const body = {
      mode,
      cwd: $('#dp-cwd').value.trim(),
      name: $('#dp-name').value.trim(),
      prompt: $('#dp-prompt').value,
      worktree: $('#dp-worktree').checked,
      model: $('#dp-model').value.trim(),
      permissionMode: mode === 'job' ? $('#dp-perm').value : '',
      mcpServers: window.ToolsView.pickerValue($('#dp-mcp')),
    };
    try {
      const r = await api('POST', '/api/dispatch/run', body);
      $('#dlg-dispatch').close();
      $('#cmd-input').value = '';
      S.text = '';
      if (r.kind === 'session' && S.opts.onSession) S.opts.onSession(r.session);
      if (r.kind === 'job' && S.opts.onJob) S.opts.onJob(r.job);
    } catch (err) {
      $('#dp-error').textContent = err.message;
      $('#dp-error').classList.remove('hidden');
    }
  }

  function bind() {
    $('#cmd-form').addEventListener('submit', (e) => { e.preventDefault(); makePlan(true); });
    $('#dp-form').addEventListener('submit', run);
    $('#dp-cancel').addEventListener('click', () => $('#dlg-dispatch').close());
    $('#dp-reroute').addEventListener('click', () => makePlan(true));
    for (const r of document.querySelectorAll('input[name="dp-mode"]')) r.addEventListener('change', () => setMode(r.value));
    window.addEventListener('keydown', (e) => {
      // ターミナル内の Ctrl+K(行の削除)は奪わない
      if (e.target.closest && e.target.closest('.xterm')) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        $('#cmd-input').focus();
        $('#cmd-input').select();
      }
    });
  }

  window.DispatchView = { init(opts) { S.opts = opts || {}; bind(); } };
})();
