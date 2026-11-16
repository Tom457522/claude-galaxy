'use strict';
// 管理 → おすすめ: 使い方の数値から作った設定の変更案を並べ、選んだものだけを PUT /api/settings で保存する

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => UI.esc(s);

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  const UNDO_KEY = 'recommendUndo';
  const PRIORITY = { high: '優先', mid: 'おすすめ', low: 'お好みで' };
  const SOURCE = { rule: '', ai: 'AI', preset: 'プリセット' };
  const S = { opts: {}, items: [], picked: new Set(), facts: null, presets: [], preset: null, summary: '', loaded: false, busy: false };

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { /* ignore */ } };
  const undoData = () => { try { return JSON.parse(lsGet(UNDO_KEY) || 'null'); } catch (_) { return null; } };

  function renderFacts() {
    const f = S.facts;
    if (!f) { $('#rc-facts').innerHTML = ''; return; }
    const usd = (v) => `$${(v || 0).toFixed(2)}`;
    const chips = [
      ['プラン', f.plan.known ? `${f.plan.name || '不明'}(週 ${f.plan.weeklyPct}% · 最大 ${f.plan.weeklyPeak}%)` : '読めません'],
      ['使った日', `${f.usage.activeDays} / ${f.usage.days} 日`],
      ['1 日の平均', usd(f.usage.avgDaily)],
      ['多い日(上位 10%)', usd(f.usage.p90Daily)],
      ['ジョブ(30 日)', `${f.jobs.last30} 件${f.jobs.fromAutomation ? `(自動 ${f.jobs.fromAutomation})` : ''}`],
      ['有効なオートメーション', `${f.automations.enabled} 件`],
    ];
    $('#rc-facts').innerHTML = chips.map(([k, v]) => `<div class="rc-fact"><small>${esc(k)}</small><b>${esc(v)}</b></div>`).join('');
  }

  function renderPresets() {
    $('#rc-preset-btns').innerHTML = S.presets.map((p) =>
      `<button class="btn rc-preset${S.preset === p.id ? ' active' : ''}" data-preset="${esc(p.id)}" title="${esc(p.description)}">${esc(p.title)}</button>`).join('');
    $('#rc-preset-clear').classList.toggle('hidden', !S.preset);
  }

  function render() {
    renderFacts();
    renderPresets();
    $('#rc-summary').classList.toggle('hidden', !S.summary);
    $('#rc-summary').innerHTML = S.summary ? `<b>✦ Claude の見立て</b> ${esc(S.summary)}` : '';
    if (!S.items.length) {
      $('#rc-list').innerHTML = `<p class="rc-ok">✓ ${S.preset ? 'このプリセットは、いまの設定と同じです' : 'いまの設定で問題ありません。使い方が変わったら、もう一度見てみてください'}</p>`;
    } else {
      $('#rc-list').innerHTML = S.items.map((it) => `<label class="rc-item rc-${esc(it.priority)}">
        <input type="checkbox" data-id="${esc(it.id)}"${S.picked.has(it.id) ? ' checked' : ''}>
        <div class="rc-body">
          <div class="rc-title"><span class="rc-pri">${esc(PRIORITY[it.priority] || '')}</span>${SOURCE[it.source] ? `<span class="mem-tag">${esc(SOURCE[it.source])}</span>` : ''}<b>${esc(it.title)}</b></div>
          <ul class="rc-changes">${it.changes.map((c) => `<li><span>${esc(c.label)}</span><s>${esc(c.fromText)}</s><i>→</i><b>${esc(c.toText)}</b></li>`).join('')}</ul>
          <p class="rc-reason">${esc(it.reason)}</p>
        </div>
      </label>`).join('');
    }
    $('#rc-apply').disabled = S.busy || !S.picked.size;
    $('#rc-apply').textContent = S.picked.size ? `選んだものを適用(${S.picked.size} 件)` : '選んだものを適用';
    const u = undoData();
    $('#rc-undo').classList.toggle('hidden', !u);
    if (u) $('#rc-undo').title = `${new Date(u.at).toLocaleString()} に適用する前の値に戻します`;
  }

  // 優先・おすすめの案は最初から選んでおく(お好みでは選ばない)
  function setItems(items, { summary = '' } = {}) {
    S.items = items || [];
    S.summary = summary;
    S.picked = new Set(S.items.filter((i) => i.priority !== 'low').map((i) => i.id));
    render();
    if (!S.preset && S.opts.onCount) S.opts.onCount(S.items.filter((i) => i.priority === 'high').length);
    if (!S.preset && window.SettingsView && window.SettingsView.markSections) {
      window.SettingsView.markSections([...new Set(S.items.flatMap((i) => i.changes.map((c) => c.section)))]);
    }
  }

  async function load(preset = null) {
    S.preset = preset;
    try {
      const r = await api('GET', `/api/settings/recommend${preset ? `?preset=${encodeURIComponent(preset)}` : ''}`);
      S.facts = r.facts;
      S.presets = r.presets;
      S.loaded = true;
      setItems(r.items);
      $('#rc-note').textContent = '';
    } catch (e) {
      $('#rc-list').innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }

  async function askAi() {
    const btn = $('#rc-ai');
    btn.disabled = true;
    btn.textContent = '✦ 考えています…';
    $('#rc-note').textContent = 'Claude に数値と設定値だけを渡しています(ツールなし。数十秒かかることがあります)';
    try {
      S.preset = null;
      const r = await api('POST', '/api/settings/recommend/ai', {});
      setItems(r.items, { summary: r.summary });
      $('#rc-note').textContent = '';
    } catch (e) {
      $('#rc-note').textContent = '';
      UI.toast(`AI のおすすめを作れませんでした: ${e.message}(規則のおすすめはそのまま使えます)`, { type: 'error', timeout: 10000 });
    } finally {
      btn.disabled = false;
      btn.textContent = '✦ AI に見直してもらう';
    }
  }

  async function apply() {
    const chosen = S.items.filter((i) => S.picked.has(i.id));
    if (!chosen.length) return;
    // あとの案が前の案を上書きする(同じ項目を 2 つの案が変えるとき)
    const patch = Object.assign({}, ...chosen.map((i) => i.patch));
    let current = {};
    try { current = await api('GET', '/api/settings'); } catch (_) { /* ignore */ }
    const prev = Object.fromEntries(Object.keys(patch).map((k) => [k, current[k]]));
    S.busy = true;
    render();
    try {
      const st = await api('PUT', '/api/settings', patch);
      lsSet(UNDO_KEY, JSON.stringify({ at: Date.now(), patch: prev }));
      if (window.SettingsView) window.SettingsView.onSettings(st);
      UI.toast(`${Object.keys(patch).length} 項目の設定を変えました`, { action: { label: '元に戻す', fn: undo } });
    } catch (e) { UI.toast(e.message, { type: 'error' }); }
    S.busy = false;
    await load(null);
  }

  async function undo() {
    const u = undoData();
    if (!u || !u.patch) return;
    try {
      const st = await api('PUT', '/api/settings', u.patch);
      lsSet(UNDO_KEY, null);
      if (window.SettingsView) window.SettingsView.onSettings(st);
      UI.toast('適用する前の設定に戻しました');
    } catch (e) { UI.toast(e.message, { type: 'error' }); }
    await load(null);
  }

  window.RecommendView = {
    init(opts) {
      S.opts = opts;
      $('#rc-list').addEventListener('change', (e) => {
        const cb = e.target.closest('input[data-id]');
        if (!cb) return;
        if (cb.checked) S.picked.add(cb.dataset.id); else S.picked.delete(cb.dataset.id);
        render();
      });
      $('#rc-preset-btns').addEventListener('click', (e) => {
        const b = e.target.closest('[data-preset]');
        if (b) load(b.dataset.preset);
      });
      $('#rc-preset-clear').addEventListener('click', () => load(null));
      $('#rc-reload').addEventListener('click', () => load(S.preset));
      $('#rc-ai').addEventListener('click', askAi);
      $('#rc-apply').addEventListener('click', apply);
      $('#rc-undo').addEventListener('click', undo);
      for (const a of document.querySelectorAll('.go-recommend')) {
        a.addEventListener('click', (e) => { e.preventDefault(); S.opts.go('recommend'); });
      }
      load(null); // サブタブの件数のために最初に一度だけ作る(Claude は呼ばない)
    },
    show() { if (S.loaded && !S.summary && !S.busy) load(S.preset); },
    // 設定が変わったら(設定画面で手で変えたときも)案を作り直す。AI の案・プリセットを見ているときはそのまま
    onSettings() {
      if (!S.loaded || S.summary || S.preset || S.busy) return;
      clearTimeout(S.timer);
      S.timer = setTimeout(() => load(null), 800);
    },
  };
})();
