'use strict';
// アプリ一覧(ランチャー)と、アプリ内タブで開く Web アプリ
//   Web アプリ   : iframe で開く(複数を同時に開いておける)。ローカル HTML は本体と別ポートから配信される
//   コマンドアプリ: opts.onLaunchCommand(app) でターミナルのセッションとして起動する

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const IS_WIN = /Windows/i.test(navigator.userAgent);

  const PRESETS = [
    { label: 'Excalidraw', type: 'web', name: 'Excalidraw', icon: '✎', url: 'https://excalidraw.com', desc: '手描き風の図をすぐ描ける' },
    { label: 'tldraw', type: 'web', name: 'tldraw', icon: '◇', url: 'https://www.tldraw.com', desc: 'ホワイトボード' },
    { label: 'Claude Code', type: 'command', name: 'Claude Code', icon: '✻', command: 'claude', desc: 'Claude Code CLI' },
    { label: 'Codex CLI', type: 'command', name: 'Codex', icon: '◎', command: 'codex', desc: 'OpenAI Codex CLI' },
    { label: 'Gemini CLI', type: 'command', name: 'Gemini', icon: '✦', command: 'gemini', desc: 'Google Gemini CLI' },
    { label: 'npm run dev', type: 'command', name: 'Dev Server', icon: '▶', command: 'npm run dev', desc: '開発サーバー' },
    IS_WIN
      ? { label: 'PowerShell', type: 'command', name: 'PowerShell', icon: '›_', command: 'powershell', desc: '素のシェル' }
      : { label: 'Shell', type: 'command', name: 'Shell', icon: '›_', command: 'bash', desc: '素のシェル' },
  ];

  const S = {
    apps: [],
    appsPort: 0,
    open: new Map(), // id -> { app, frame, tab }
    cur: 'launcher',
    editing: null,
    opts: {},
    listeners: [],
  };

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

  async function refresh() {
    try {
      const d = await api('GET', '/api/apps');
      S.apps = d.apps || [];
      S.appsPort = d.appsPort;
    } catch (e) { console.error(e); }
    render();
    for (const fn of S.listeners) fn(S.apps);
  }

  const iconOf = (a) => esc(a.icon || (a.type === 'web' ? '◰' : '›_'));
  function metaOf(a) {
    if (a.type === 'web') {
      if (a.local) return `LOCAL · ${a.url.replace(/^.*[\\/]/, '')}${a.missing ? ' · 見つかりません' : ''}`;
      try { return `WEB · ${new URL(a.url).host}`; } catch (_) { return 'WEB'; }
    }
    return `CMD · ${a.command}${a.cwd ? ` @ ${a.cwd.replace(/^.*[\\/]/, '')}` : ''}`;
  }

  // ---- ランチャー ----
  function card(a) {
    return `<div class="app-card t-${a.type}${a.missing ? ' missing' : ''}" data-id="${esc(a.id)}" title="${esc(a.type === 'web' ? a.url : `${a.command}${a.cwd ? `\n${a.cwd}` : ''}`)}">` +
      `<div class="ac-icon">${iconOf(a)}</div>` +
      `<div class="ac-body"><div class="ac-name">${esc(a.name)}</div><div class="ac-meta">${esc(metaOf(a))}</div>` +
      `${a.desc ? `<div class="ac-desc">${esc(a.desc)}</div>` : ''}</div>` +
      '<div class="ac-btns">' +
      `<button class="ac-play" data-act="launch" title="${a.type === 'web' ? '開く' : '起動'}">▶</button>` +
      '<button class="ac-edit" data-act="edit" title="編集">⚙</button>' +
      '</div></div>';
  }
  const addCard = (type) => `<button class="app-card app-add" data-act="add" data-type="${type}"><span>＋</span>${type === 'web' ? 'Web アプリを追加' : 'コマンドを追加'}</button>`;

  function render() {
    $('#apps-web').innerHTML = S.apps.filter((a) => a.type === 'web').map(card).join('') + addCard('web');
    $('#apps-cmd').innerHTML = S.apps.filter((a) => a.type === 'command').map(card).join('') + addCard('command');
    renderDock();
    // 開いているタブの名前・アイコンを最新に
    for (const [id, o] of S.open) {
      const a = S.apps.find((x) => x.id === id);
      if (!a) { closeWeb(id); continue; }
      o.app = a;
      o.tab.querySelector('.ai').innerHTML = iconOf(a);
      o.tab.querySelector('.an').textContent = a.name;
    }
  }

  // ホーム画面左上の MICRO APPS パネル
  function renderDock() {
    const el = $('#g-apps');
    if (!el) return;
    const max = 6;
    const list = S.apps.slice(0, max);
    el.innerHTML =
      '<div class="g-apps-head"><span>◈ MICRO APPS</span>' +
      '<button class="g-apps-all" data-act="all">すべて ›</button></div>' +
      list.map((a) => `<button class="g-app" data-id="${esc(a.id)}" title="${esc(a.desc || a.name)}">` +
        `<span class="ga-icon t-${a.type}">${iconOf(a)}</span><span class="ga-text"><b>${esc(a.name)}</b><small>${esc(metaOf(a))}</small></span>` +
        `<span class="ga-go">${a.type === 'web' ? '↗' : '▶'}</span></button>`).join('') +
      (S.apps.length > max ? `<div class="g-apps-more">ほか ${S.apps.length - max} 件</div>` : '') +
      (S.apps.length ? '' : '<button class="g-app g-app-add" data-act="add">＋ アプリを追加</button>');
  }

  // ---- Web アプリのタブ ----
  function frameSrc(a) {
    if (!a.local) return a.src;
    return `${location.protocol}//${location.hostname}:${S.appsPort}${a.src}`;
  }
  function sandboxFor(src) {
    const base = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
    let sameAsUs = false;
    try { sameAsUs = new URL(src, location.href).origin === location.origin; } catch (_) { /* ignore */ }
    return sameAsUs ? base : `${base} allow-same-origin`; // 本体と同じオリジンのページには同一オリジン権限を渡さない
  }

  function openWeb(a) {
    if (a.missing) { alert(`ファイルが見つかりません:\n${a.url}`); return; }
    let o = S.open.get(a.id);
    if (!o) {
      const src = frameSrc(a);
      const frame = document.createElement('iframe');
      frame.className = 'app-frame';
      frame.src = src;
      frame.setAttribute('sandbox', sandboxFor(src));
      frame.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      $('#apps-frames').appendChild(frame);
      const tab = document.createElement('button');
      tab.className = 'apps-tab';
      tab.dataset.open = a.id;
      tab.innerHTML = `<span class="ai">${iconOf(a)}</span><span class="an">${esc(a.name)}</span><span class="ax" data-close="${esc(a.id)}" title="閉じる">✕</span>`;
      $('#apps-tabs').appendChild(tab);
      o = { app: a, frame, tab };
      S.open.set(a.id, o);
    }
    select(a.id);
    S.opts.showTab();
  }

  function closeWeb(id) {
    const o = S.open.get(id);
    if (!o) return;
    o.frame.remove();
    o.tab.remove();
    S.open.delete(id);
    if (S.cur === id) select([...S.open.keys()].pop() || 'launcher');
  }

  function select(id) {
    S.cur = id;
    const web = id !== 'launcher';
    $('#apps-launcher').classList.toggle('hidden', web);
    $('#apps-frames').classList.toggle('hidden', !web);
    $('#apps-ext').classList.toggle('hidden', !web);
    $('#apps-reload').classList.toggle('hidden', !web);
    for (const b of document.querySelectorAll('.apps-tab')) b.classList.toggle('cur', b.dataset.open === id);
    for (const [oid, o] of S.open) o.frame.classList.toggle('cur', oid === id);
  }

  function launch(id) {
    const a = S.apps.find((x) => x.id === id);
    if (!a) return;
    if (a.type === 'web') openWeb(a);
    else S.opts.onLaunchCommand(a);
  }

  // ---- 追加 / 編集ダイアログ ----
  function setType(type) {
    for (const r of document.querySelectorAll('input[name="app-type"]')) r.checked = r.value === type;
    $('#dlg-app .app-web').classList.toggle('hidden', type !== 'web');
    $('#dlg-app .app-cmd').classList.toggle('hidden', type !== 'command');
    $('#app-icon').placeholder = type === 'web' ? '◰' : '›_';
    $('#app-presets').innerHTML = PRESETS.filter((p) => p.type === type)
      .map((p, i) => `<button type="button" class="chip" data-preset="${PRESETS.indexOf(p)}">${esc(p.icon)} ${esc(p.label)}</button>`).join('');
  }
  const curType = () => (document.querySelector('input[name="app-type"]:checked') || {}).value || 'web';

  function openEditor(a, type) {
    S.editing = a || null;
    $('#app-title').textContent = a ? 'アプリを編集' : 'アプリを追加';
    setType(a ? a.type : (type || 'web'));
    $('#app-name').value = a ? a.name : '';
    $('#app-icon').value = a ? a.icon || '' : '';
    $('#app-desc').value = a ? a.desc || '' : '';
    $('#app-url').value = a && a.type === 'web' ? a.url : '';
    $('#app-command').value = a && a.type === 'command' ? a.command : '';
    $('#app-cwd').value = a && a.type === 'command' ? a.cwd || '' : '';
    $('#app-delete').classList.toggle('hidden', !a);
    $('#app-error').classList.add('hidden');
    $('#dlg-app').showModal();
    $('#app-name').focus();
  }

  function bindUI() {
    $('#apps-add').addEventListener('click', () => openEditor(null));
    const onGrid = (e) => {
      const b = e.target.closest('[data-act]');
      const c = e.target.closest('.app-card[data-id]');
      if (b && b.dataset.act === 'add') { openEditor(null, b.dataset.type); return; }
      if (!c) return;
      const a = S.apps.find((x) => x.id === c.dataset.id);
      if (b && b.dataset.act === 'edit') openEditor(a);
      else launch(c.dataset.id);
    };
    $('#apps-web').addEventListener('click', onGrid);
    $('#apps-cmd').addEventListener('click', onGrid);

    $('.apps-bar').addEventListener('click', (e) => {
      const x = e.target.closest('[data-close]');
      if (x) { e.stopPropagation(); closeWeb(x.dataset.close); return; }
      const t = e.target.closest('.apps-tab');
      if (t) select(t.dataset.open);
    });
    $('.apps-bar').addEventListener('auxclick', (e) => { // 中クリックで閉じる
      const t = e.target.closest('.apps-tab');
      if (e.button === 1 && t && t.dataset.open !== 'launcher') closeWeb(t.dataset.open);
    });
    $('#apps-reload').addEventListener('click', () => {
      const o = S.open.get(S.cur);
      if (o) o.frame.src = frameSrc(o.app);
    });
    $('#apps-ext').addEventListener('click', () => {
      const o = S.open.get(S.cur);
      if (o) window.open(frameSrc(o.app), '_blank', 'noopener');
    });

    $('#g-apps').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b && b.dataset.act === 'all') { select('launcher'); S.opts.showTab(); return; }
      if (b && b.dataset.act === 'add') { openEditor(null); return; }
      const g = e.target.closest('.g-app[data-id]');
      if (g) launch(g.dataset.id);
    });

    for (const r of document.querySelectorAll('input[name="app-type"]')) r.addEventListener('change', () => setType(curType()));
    $('#app-presets').addEventListener('click', (e) => {
      const b = e.target.closest('[data-preset]');
      if (!b) return;
      const p = PRESETS[Number(b.dataset.preset)];
      $('#app-name').value = p.name;
      $('#app-icon').value = p.icon;
      $('#app-desc').value = p.desc || '';
      if (p.type === 'web') $('#app-url').value = p.url; else $('#app-command').value = p.command;
    });
    $('#app-cancel').addEventListener('click', () => $('#dlg-app').close());
    $('#app-delete').addEventListener('click', async () => {
      const a = S.editing;
      if (!a || !confirm(`「${a.name}」を一覧から削除しますか?`)) return;
      try { await api('DELETE', `/api/apps/${a.id}`); } catch (_) { /* ignore */ }
      $('#dlg-app').close();
      refresh();
    });
    $('#app-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const type = curType();
      const body = {
        type, name: $('#app-name').value, icon: $('#app-icon').value, desc: $('#app-desc').value,
        ...(type === 'web' ? { url: $('#app-url').value } : { command: $('#app-command').value, cwd: $('#app-cwd').value }),
      };
      try {
        if (S.editing) await api('PUT', `/api/apps/${S.editing.id}`, body);
        else await api('POST', '/api/apps', body);
        $('#dlg-app').close();
        refresh();
      } catch (err) {
        const el = $('#app-error');
        el.textContent = err.message;
        el.classList.remove('hidden');
      }
    });
  }

  // ---- 公開 API ----
  async function init(opts) {
    S.opts = opts;
    bindUI();
    await refresh();
  }

  window.AppsView = {
    init,
    refresh,
    launch,
    openEditor,
    get: (id) => S.apps.find((a) => a.id === id) || null,
    commandApps: () => S.apps.filter((a) => a.type === 'command'),
    onChange: (fn) => S.listeners.push(fn),
  };
}());
