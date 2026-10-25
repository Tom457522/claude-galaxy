'use strict';
// ホーム画面の 2D 表示: ルートフォルダごとに、直下のフォルダをカードで並べる
// データ(走査結果・セッション・フィルター)は GraphView が読み込んだものをそのまま使う

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('ja-JP');
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* ignore */ } },
  };
  const normPath = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const keyPath = (p) => { const n = normPath(p); return /^[a-zA-Z]:/.test(n) || n.startsWith('//') ? n.toLowerCase() : n; };
  const under = (cwd, dir) => { const c = keyPath(cwd); const k = keyPath(dir); return c === k || c.startsWith(`${k}/`); };

  const S = {
    sort: store.get('h2Sort', 'sessions'),
    folded: new Set(store.get('h2Folded', [])), // 折りたたんだルート
    open: new Set(), // サブフォルダを開いたフォルダ
    allIds: [],
  };

  const G = () => window.GraphView;
  const catColor = (c) => (Object.hasOwn(G().catColors, c) ? G().catColors[c] : G().catColors.Other);
  const statusJa = (st) => G().statusJa[st] || st;

  function sessHtml(s) {
    return `<button class="h2-sess" data-act="open-session" data-id="${esc(s.id)}" title="${esc(s.cwd)}">` +
      `<span class="mini">${G().mascotSVG(s.status)}</span><span class="h2-sess-name">${esc(s.name)}</span><small>${esc(statusJa(s.status))}</small></button>`;
  }

  function render() {
    const list = $('#h2-list');
    if (!list || !G() || G().view() !== '2d') return;
    const { raw, sessions, f, mode, depth, roots: rootPaths } = G().snapshot();
    if (!raw) { list.innerHTML = ''; return; }

    const folders = raw.nodes.filter((n) => n.kind === 'root' || n.kind === 'folder');
    const kids = new Map();
    for (const n of folders) {
      if (!n.parent) continue;
      if (!kids.has(n.parent)) kids.set(n.parent, []);
      kids.get(n.parent).push(n);
    }
    const childrenOf = (id) => kids.get(id) || [];
    const live = sessions.filter((s) => s.cwd);
    const sessMemo = new Map();
    const sessOf = (id) => {
      if (!sessMemo.has(id)) sessMemo.set(id, live.filter((s) => under(s.cwd, id)));
      return sessMemo.get(id);
    };

    // フィルター(3D と同じ条件。配下に通るフォルダがあれば親も残す)
    const q = f.search.trim().toLowerCase();
    const matches = (n) => !!q && (n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q));
    const passSelf = (n) => !f.disabledCats.has(n.cat) && n.totalFiles >= f.minFiles &&
      (!f.onlySessions || sessOf(n.id).length > 0) && (!q || !f.searchOnly || matches(n));
    const visMemo = new Map();
    const visible = (n) => {
      if (!visMemo.has(n.id)) visMemo.set(n.id, passSelf(n) || childrenOf(n.id).some(visible));
      return visMemo.get(n.id);
    };
    const hitMemo = new Map();
    const hit = (n) => {
      if (!hitMemo.has(n.id)) hitMemo.set(n.id, matches(n) || childrenOf(n.id).some(hit));
      return hitMemo.get(n.id);
    };
    const sorter = {
      sessions: (a, b) => sessOf(b.id).length - sessOf(a.id).length || b.totalFiles - a.totalFiles,
      files: (a, b) => b.totalFiles - a.totalFiles,
      name: (a, b) => a.name.localeCompare(b.name, 'ja'),
    }[S.sort] || ((a, b) => b.totalFiles - a.totalFiles);
    const shown = (id) => childrenOf(id).filter(visible).sort(sorter);
    S.allIds = folders.filter((n) => n.kind === 'folder' && childrenOf(n.id).length).map((n) => n.id);

    // サブフォルダの木(開いたものだけ下をたどる)
    const rowsHtml = (id, level) => shown(id).map((c) => {
      const has = childrenOf(c.id).length > 0;
      const op = S.open.has(c.id);
      const sc = sessOf(c.id).length;
      return `<div class="h2-row ${q && !hit(c) ? 'dim' : ''} ${matches(c) ? 'hit' : ''}" style="--lv:${level}"${has ? ` data-act="toggle" data-id="${esc(c.id)}"` : ''} title="${esc(c.id)}">` +
        `<span class="h2-caret">${has ? (op ? '▾' : '▸') : ''}</span><i class="h2-dot" style="background:${catColor(c.cat)}"></i>` +
        `<span class="h2-row-name">${esc(c.name)}</span>${sc ? `<span class="h2-badge">● ${sc}</span>` : ''}` +
        `<span class="h2-row-n">${fmt(c.totalFiles)}</span>` +
        `<button class="h2-row-go" data-act="launch" data-path="${esc(c.id)}" title="ここで Claude を起動">▶</button></div>` +
        (has && op ? rowsHtml(c.id, level + 1) : '');
    }).join('');

    const cardHtml = (n) => {
      const kidsAll = childrenOf(n.id);
      const op = S.open.has(n.id);
      const sess = sessOf(n.id);
      const cats = Object.entries(n.cats || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => esc(c)).join(' / ') || esc(n.cat);
      return `<article class="h2-card ${q && !hit(n) ? 'dim' : ''} ${matches(n) ? 'hit' : ''}" style="--cat:${catColor(n.cat)}">` +
        `<div class="h2-card-head" title="${esc(n.id)}"><i class="h2-dot"></i><b class="h2-name">${esc(n.name)}</b><span class="h2-count">${fmt(n.totalFiles)}<small> files</small></span></div>` +
        `<div class="h2-sub">${cats}${n.unreadable ? ' ・ 読み取れませんでした' : ''}</div>` +
        (sess.length ? `<div class="h2-sesses">${sess.map(sessHtml).join('')}</div>` : '') +
        (kidsAll.length ? `<button class="h2-more" data-act="toggle" data-id="${esc(n.id)}">${op ? '▾' : '▸'} サブフォルダ ${fmt(n.dirs)}${n.more ? `(未展開 ${fmt(n.more)})` : ''}</button>` +
          (op ? `<div class="h2-tree">${rowsHtml(n.id, 0)}</div>` : '')
          : (n.dirs ? `<div class="h2-sub">サブフォルダ ${fmt(n.dirs)}(深さを上げると表示)</div>` : '')) +
        '<div class="h2-btns">' +
        `<button class="btn primary" data-act="launch" data-path="${esc(n.id)}">ここで Claude を起動</button>` +
        `<button class="btn" data-act="focus" data-path="${esc(n.id)}" title="このフォルダの中だけを一覧にします">絞り込み</button>` +
        `<button class="btn" data-act="focus3d" data-path="${esc(n.id)}" title="3D グラフでこのフォルダを表示">3D</button>` +
        '</div></article>';
    };

    const sections = [];
    for (const r of folders.filter((n) => n.kind === 'root')) {
      const cards = shown(r.id);
      const sess = sessOf(r.id);
      // ルート直下(どのサブフォルダにも入らない)セッション
      const direct = sess.filter((s) => !childrenOf(r.id).some((c) => under(s.cwd, c.id)));
      const fold = S.folded.has(keyPath(r.id));
      sections.push(`<section class="h2-sec">` +
        `<header class="h2-sec-head" data-act="fold" data-id="${esc(r.id)}">` +
        `<span class="h2-caret">${fold ? '▸' : '▾'}</span><b>${esc(r.name)}</b><span class="h2-path">${esc(r.id)}</span>` +
        `<span class="h2-meta">${fmt(cards.length)} フォルダ ・ ${fmt(r.totalFiles)} files${sess.length ? ` ・ <em>セッション ${sess.length}</em>` : ''}</span>` +
        `<button class="h2-row-go" data-act="launch" data-path="${esc(r.id)}" title="ここで Claude を起動">▶</button></header>` +
        (fold ? '' :
          (direct.length ? `<div class="h2-sesses h2-direct">${direct.map(sessHtml).join('')}</div>` : '') +
          (cards.length ? `<div class="h2-grid">${cards.map(cardHtml).join('')}</div>` : '<p class="g-note">表示するフォルダがありません(フィルターや深さを確認してください)</p>')) +
        '</section>');
    }
    // どのルートにも入らないセッション(ホームのときだけ)
    if (mode === 'home') {
      const outside = live.filter((s) => !rootPaths.some((p) => under(s.cwd, p)));
      if (outside.length) {
        sections.push(`<section class="h2-sec"><header class="h2-sec-head"><span class="h2-caret"></span><b>ルート外のセッション</b><span class="h2-meta">${outside.length}</span></header>` +
          `<div class="h2-sesses h2-direct">${outside.map(sessHtml).join('')}</div></section>`);
      }
    }

    const top = list.scrollTop;
    list.innerHTML = sections.join('');
    list.scrollTop = top;
    $('#h2-note').textContent = folders.length ? `深さ ${depth} まで読み込み済み(深さは右のパネルで変更)` : '';
  }

  function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'launch') G().launch(b.dataset.path);
    else if (act === 'open-session') G().openSession(b.dataset.id);
    else if (act === 'focus') G().focusFolder(b.dataset.path);
    else if (act === 'focus3d') { G().setView('3d'); G().focusFolder(b.dataset.path); }
    else if (act === 'toggle') {
      if (S.open.has(b.dataset.id)) S.open.delete(b.dataset.id); else S.open.add(b.dataset.id);
      render();
    } else if (act === 'fold') {
      const k = keyPath(b.dataset.id);
      if (S.folded.has(k)) S.folded.delete(k); else S.folded.add(k);
      store.set('h2Folded', [...S.folded]);
      render();
    } else if (act === 'expand-all') { S.open = new Set(S.allIds); render(); } else if (act === 'collapse-all') { S.open.clear(); render(); }
  }

  function init() {
    $('#home2d').addEventListener('click', onClick);
    $('#h2-sort').value = S.sort;
    $('#h2-sort').addEventListener('change', (e) => { S.sort = e.target.value; store.set('h2Sort', S.sort); render(); });
    G().onChange(render);
    render();
  }

  window.Home2DView = { init, render };
}());
