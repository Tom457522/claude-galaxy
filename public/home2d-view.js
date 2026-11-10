'use strict';
// ホーム画面の 2D 表示: 左上の起点(HOME、またはタップしたフォルダ)から右へ、階層ごとの列にフォルダのカードを並べるツリー
// (Miro のマインドマップのような形)。データ(走査結果・セッション・フィルター)は GraphView が読み込んだものをそのまま使う

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
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const CARD_H = 28;
  const ROW = 36;
  const COL_GAP = 56;
  const kidLimit = () => (innerWidth < 700 ? 5 : 8); // 子が多い親は、上位の数件と「ほか N 件」だけを出す

  const S = {
    sort: store.get('h2Sort', 'sessions'),
    levels: store.get('h2Levels', 2), // 起点から何段先まで出すか(1〜3、0 はすべて)
    origin: null, // 起点にしたフォルダの id(null なら HOME / 絞り込みのルート)
    expanded: new Set(), // 「ほか N 件」を広げた親
    cards: [], // 表示するカード(フォルダ・「ほか N 件」)
    byId: new Map(), // id → カード(位置を引き継いでなめらかに動かすため、作り直しても残す)
    edges: [], // [親カード, 子カード]
    t: { x: 0, y: 0, k: 1 }, // 表示の移動と倍率
    rootCard: null,
    drag: null, // つかんでいるカードと、その先のカード
    needFit: true,
  };

  const G = () => window.GraphView;
  const catColor = (c) => (Object.hasOwn(G().catColors, c) ? G().catColors[c] : G().catColors.Other);
  const statusJa = (st) => G().statusJa[st] || st;
  const cssVar = (name, d) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || d;

  let canvas = null;
  let ctx = null;
  let W = 0;
  let H = 0;
  let DPR = 1;
  let raf = 0;

  // ---- データからツリーを作る ----
  function build() {
    const { raw, sessions, f, mode } = G().snapshot();
    if (!raw) { S.cards = []; S.edges = []; S.rootCard = null; return null; }
    const folders = raw.nodes.filter((n) => n.kind === 'hub' || n.kind === 'root' || n.kind === 'folder');
    const node = new Map(folders.map((n) => [n.id, n]));
    const hub = folders.find((n) => n.kind === 'hub');
    const parentOf = (n) => (n.kind === 'root' ? (hub ? hub.id : null) : n.parent);
    const kids = new Map();
    for (const n of folders) {
      const p = parentOf(n);
      if (!p) continue;
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(n);
    }
    const childrenOf = (id) => kids.get(id) || [];
    const live = sessions.filter((s) => s.cwd);
    const sessMemo = new Map();
    const sessOf = (n) => {
      if (n.kind === 'hub') return live;
      if (!sessMemo.has(n.id)) sessMemo.set(n.id, live.filter((s) => under(s.cwd, n.id)));
      return sessMemo.get(n.id);
    };

    // フィルター(3D と同じ条件。配下に通るフォルダがあれば親も残す)
    const q = f.search.trim().toLowerCase();
    const matches = (n) => !!q && n.kind !== 'hub' && (n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q));
    const passSelf = (n) => !f.disabledCats.has(n.cat) && n.totalFiles >= f.minFiles &&
      (!f.onlySessions || sessOf(n).length > 0) && (!q || !f.searchOnly || matches(n));
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
      sessions: (a, b) => sessOf(b).length - sessOf(a).length || b.totalFiles - a.totalFiles,
      files: (a, b) => b.totalFiles - a.totalFiles,
      name: (a, b) => a.name.localeCompare(b.name, 'ja'),
    }[S.sort] || ((a, b) => b.totalFiles - a.totalFiles);
    // 検索中は、当たったフォルダ(とその親)を先に並べる
    const order = (a, b) => (q ? hit(b) - hit(a) : 0) || sorter(a, b);

    // 起点:タップしたフォルダ → HOME → 絞り込みのルート
    let origin = S.origin && node.get(S.origin);
    if (!origin) { S.origin = null; origin = hub || folders.find((n) => n.kind === 'root') || null; }
    if (!origin) { S.cards = []; S.edges = []; S.rootCard = null; return null; }

    const limit = S.levels > 0 ? S.levels : Infinity;
    const cards = [];
    const edges = [];
    const keep = new Set();
    const lim = kidLimit();
    const cardOf = (n, lv) => {
      let c = S.byId.get(n.id);
      if (!c) { c = { id: n.id }; S.byId.set(n.id, c); }
      Object.assign(c, {
        n, lv, isMore: false, sess: sessOf(n), dim: !!q && !hit(n), hit: matches(n),
        label: n.kind === 'hub' ? 'HOME' : n.name, more: 0,
      });
      keep.add(c.id); cards.push(c);
      return c;
    };
    const moreOf = (pc, count, open) => {
      const id = `more:${pc.id}`;
      let c = S.byId.get(id);
      if (!c) { c = { id }; S.byId.set(id, c); }
      Object.assign(c, { isMore: true, pid: pc.id, lv: pc.lv + 1, count, label: open ? 'たたむ' : `ほか ${fmt(count)} 件` });
      keep.add(id); cards.push(c);
      return c;
    };
    // 起点から下へたどる(階層の外は「+数字」で数だけ出す)
    (function walk(n, lv) {
      const pc = cardOf(n, lv);
      const ks = childrenOf(n.id).filter(visible).sort(order);
      if (lv >= limit) { pc.more = ks.length + (n.more || 0); pc.kids = []; return pc; }
      pc.more = n.more || 0; // 走査の深さが足りず読み込んでいないサブフォルダ
      let shown = ks;
      let mc = null;
      if (ks.length > lim) {
        const open = S.expanded.has(n.id);
        if (!open) shown = ks.slice(0, lim - 1);
        mc = moreOf(pc, ks.length - shown.length, open);
      }
      pc.kids = shown.map((k) => { const kc = walk(k, lv + 1); edges.push([pc, kc]); return kc; });
      if (mc) { pc.kids.push(mc); edges.push([pc, mc]); }
      return pc;
    }(origin, 0));
    for (const id of [...S.byId.keys()]) if (!keep.has(id)) S.byId.delete(id);
    S.cards = cards;
    S.edges = edges;
    S.rootCard = S.byId.get(origin.id);
    return { origin, mode, q };
  }

  // ---- 位置を決める(列の幅はその段でいちばん長いカード) ----
  const fontOf = (c) => (c === S.rootCard ? `700 13px ${cssVar('--mono', 'monospace')}` : `12px ${cssVar('--mono', 'monospace')}`);
  const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  function layout() {
    if (!ctx || !S.rootCard) return;
    const colW = [];
    for (const c of S.cards) {
      ctx.font = fontOf(c);
      const label = c.isMore ? `${c.label} ▸` : cut(c.label, 28);
      c.text = label;
      let w = ctx.measureText(label).width + (c.isMore ? 22 : 34);
      if (!c.isMore) {
        ctx.font = `11px ${cssVar('--mono', 'monospace')}`;
        c.count = c.n.kind === 'hub' ? '' : fmt(c.n.totalFiles);
        w += c.count ? ctx.measureText(c.count).width + 10 : 0;
        if (c.sess.length) w += ctx.measureText(`● ${c.sess.length}`).width + 16;
      }
      c.w = Math.ceil(w);
      colW[c.lv] = Math.max(colW[c.lv] || 0, c.w);
    }
    const colX = [0];
    for (let l = 1; l < colW.length; l++) colX[l] = colX[l - 1] + (colW[l - 1] || 0) + COL_GAP;
    let row = 0;
    // 葉を上から順に並べ、親は最初の子と同じ高さにそろえる(左上が起点になる)
    (function place(c) {
      c.tx = colX[c.lv] || 0;
      const ks = c.kids || [];
      if (!ks.length) { c.ty = row * ROW; row++; } else { ks.forEach(place); c.ty = ks[0].ty; }
    }(S.rootCard));
    for (const c of S.cards) if (c.x === undefined) { c.x = c.tx; c.y = c.ty; }
  }

  // ---- 表示の移動・倍率 ----
  function startView(all) {
    if (!S.rootCard) return;
    const pad = 18;
    const xs = S.cards.map((c) => c.tx + c.w + (c.more ? 40 : 0));
    const ys = S.cards.map((c) => c.ty + CARD_H);
    const fitK = Math.min((W - pad * 2) / Math.max(1, Math.max(...xs) - S.rootCard.tx), (H - pad * 2) / Math.max(1, Math.max(...ys) - S.rootCard.ty));
    // 起点を左上に、読める大きさで置く。全体が読める大きさで収まるなら全体を見せる
    const k = all ? Math.max(0.2, Math.min(1.3, fitK)) : (fitK >= 0.85 ? Math.min(1.15, fitK) : 1);
    S.t = { k, x: pad - S.rootCard.tx * k, y: pad - S.rootCard.ty * k };
    kick();
  }
  const toWorld = (sx, sy) => [(sx - S.t.x) / S.t.k, (sy - S.t.y) / S.t.k];
  function zoomAt(sx, sy, factor) {
    const k = Math.max(0.2, Math.min(3, S.t.k * factor));
    const [wx, wy] = toWorld(sx, sy);
    S.t = { k, x: sx - wx * k, y: sy - wy * k };
    kick();
  }
  function cardAt(sx, sy) {
    const [x, y] = toWorld(sx, sy);
    const m = 4 / S.t.k;
    for (let i = S.cards.length - 1; i >= 0; i--) {
      const c = S.cards[i];
      if (x >= c.x - m && x <= c.x + c.w + m && y >= c.y - m && y <= c.y + CARD_H + m) return c;
    }
    return null;
  }

  // ---- 描画 ----
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  // 色はテーマ(ダーク / ライト)の CSS 変数から、描くたびに読む
  function theme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    return {
      accent: v('--accent', '#d97757'), bright: v('--accent-bright', '#f08a5d'), dimA: v('--accent-dim', 'rgba(217, 119, 87, .18)'),
      card: v('--panel-2', '#181818'), border: v('--border', '#2a2420'), heading: v('--heading', '#f4ede6'),
      muted: v('--muted', '#8c8279'), mono: v('--mono', 'monospace'),
    };
  }
  function draw() {
    if (!ctx) return;
    const th = theme();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const { k } = S.t;
    // ホワイトボードのような点の方眼(拡大すると細かく、縮小すると粗く)
    let step = 24;
    while (step * k < 14) step *= 2;
    const [wx0, wy0] = toWorld(0, 0);
    const [wx1, wy1] = toWorld(W, H);
    ctx.fillStyle = th.muted; ctx.globalAlpha = 0.22;
    for (let x = Math.floor(wx0 / step) * step; x < wx1; x += step) {
      for (let y = Math.floor(wy0 / step) * step; y < wy1; y += step) ctx.fillRect(S.t.x + x * k - 0.75, S.t.y + y * k - 0.75, 1.5, 1.5);
    }
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.translate(S.t.x, S.t.y); ctx.scale(k, k);
    const { accent, bright, mono } = th;
    // 親の右端から子の左端へ、なめらかな曲線でつなぐ
    for (const [p, c] of S.edges) {
      const x0 = p.x + p.w; const y0 = p.y + CARD_H / 2; const x1 = c.x; const y1 = c.y + CARD_H / 2;
      const mx = x0 + Math.max(16, (x1 - x0) / 2);
      ctx.globalAlpha = c.isMore ? 0.35 : (c.dim ? 0.12 : 0.5);
      ctx.strokeStyle = c.isMore ? accent : catColor(c.n.cat);
      ctx.lineWidth = 1.3;
      ctx.setLineDash(c.isMore ? [4, 4] : []);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.bezierCurveTo(mx, y0, mx, y1, x1, y1); ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const c of S.cards) {
      const cy = c.y + CARD_H / 2;
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      if (c.isMore) {
        ctx.globalAlpha = 1;
        roundRect(c.x, c.y, c.w, CARD_H, 7);
        ctx.fillStyle = th.card; ctx.fill(); ctx.fillStyle = th.dimA; ctx.fill();
        ctx.setLineDash([4, 4]); ctx.strokeStyle = accent; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
        ctx.font = `12px ${mono}`; ctx.fillStyle = bright; ctx.fillText(c.text, c.x + 11, cy + 0.5);
        continue;
      }
      const root = c === S.rootCard;
      const col = c.n.kind === 'hub' ? accent : catColor(c.n.cat);
      ctx.globalAlpha = c.dim ? 0.3 : 1;
      if (c.hit) { ctx.shadowColor = accent; ctx.shadowBlur = 14; }
      roundRect(c.x, c.y, c.w, CARD_H, root ? 9 : 7);
      ctx.fillStyle = th.card; ctx.fill();
      ctx.shadowBlur = 0;
      if (root) { ctx.fillStyle = th.dimA; ctx.fill(); }
      ctx.lineWidth = root || c.hit ? 1.6 : 1;
      ctx.strokeStyle = root || c.hit ? bright : `${col}88`; ctx.stroke();
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(c.x + 13, cy, 4, 0, Math.PI * 2); ctx.fill();
      ctx.font = fontOf(c); ctx.fillStyle = th.heading;
      ctx.fillText(c.text, c.x + 24, cy + 0.5);
      let rx = c.x + c.w - 10;
      ctx.textAlign = 'right';
      if (c.sess.length) {
        ctx.font = `700 11px ${mono}`; ctx.fillStyle = bright;
        const t = `● ${c.sess.length}`;
        ctx.fillText(t, rx, cy + 0.5);
        rx -= ctx.measureText(t).width + 10;
      }
      if (c.count) { ctx.font = `11px ${mono}`; ctx.fillStyle = th.muted; ctx.fillText(c.count, rx, cy + 0.5); }
      if (c.more) { // 階層の外(または未読み込み)にまだ続くサブフォルダの数
        const t = `+${fmt(c.more)}`;
        ctx.font = `700 10.5px ${mono}`; ctx.textAlign = 'left';
        const tw = ctx.measureText(t).width + 10;
        roundRect(c.x + c.w + 6, cy - 8, tw, 16, 8); ctx.fillStyle = th.dimA; ctx.fill();
        ctx.fillStyle = bright; ctx.fillText(t, c.x + c.w + 11, cy + 0.5);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // カードを新しい位置へなめらかに動かす(つかんだカードとその先はずらした位置へ)。止まったら描くのをやめる
  function frame() {
    raf = 0;
    if (!visibleNow()) return;
    let moving = false;
    const e = reduceMotion ? 1 : 0.22;
    const d = S.drag;
    for (const c of S.cards) {
      if (c.tx === undefined) continue;
      const off = d && d.set.has(c);
      const gx = c.tx + (off ? d.dx : 0); const gy = c.ty + (off ? d.dy : 0);
      const dx = gx - c.x; const dy = gy - c.y;
      if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) { c.x += dx * e; c.y += dy * e; moving = true; } else { c.x = gx; c.y = gy; }
    }
    draw();
    if (moving) raf = requestAnimationFrame(frame);
  }
  function kick() { if (!raf) raf = requestAnimationFrame(frame); }
  const visibleNow = () => !!canvas && G() && G().view() === '2d' && canvas.offsetParent !== null;

  function resize() {
    if (!canvas) return;
    const r = canvas.parentElement.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    kick();
  }

  // ---- 起点の詳細(タップしたフォルダ) ----
  function renderDetail(info) {
    const box = $('#h2-detail');
    const c = S.rootCard;
    if (!c || !S.origin || !info) { box.hidden = true; box.innerHTML = ''; return; }
    const n = c.n;
    const cats = Object.entries(n.cats || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => esc(k)).join(' / ') || esc(n.cat);
    box.innerHTML = `<div class="h2-d-head"><i class="h2-dot" style="background:${catColor(n.cat)}"></i><b title="${esc(n.id)}">${esc(n.name)}</b></div>` +
      `<div class="h2-sub" title="${esc(n.id)}">${esc(n.id)}</div>` +
      `<div class="h2-sub">${fmt(n.totalFiles)} files ・ ${cats}${n.unreadable ? ' ・ 読み取れませんでした' : ''}</div>` +
      (c.sess.length ? `<div class="h2-sesses">${c.sess.map((s) => `<button class="h2-sess" data-act="open-session" data-id="${esc(s.id)}" title="${esc(s.cwd)}">` +
        `<span class="mini">${G().mascotSVG(s.status)}</span><span class="h2-sess-name">${esc(s.name)}</span><small>${esc(statusJa(s.status))}</small></button>`).join('')}</div>` : '') +
      '<div class="h2-btns">' +
      `<button class="btn primary" data-act="launch" data-path="${esc(n.id)}">ここで Claude を起動</button>` +
      `<button class="btn" data-act="focus" data-path="${esc(n.id)}" title="このフォルダの中だけを読み込み直します">絞り込み</button>` +
      `<button class="btn" data-act="focus3d" data-path="${esc(n.id)}" title="3D グラフでこのフォルダを表示">3D</button>` +
      '</div><div class="h2-btns">' +
      '<button class="btn" data-act="origin-up" title="ひとつ上のフォルダを起点にします">↑ 上へ</button>' +
      '<button class="btn" data-act="origin-reset">起点を戻す</button></div>';
    box.hidden = false;
  }

  function render() {
    if (!canvas || !G() || G().view() !== '2d') return;
    const info = build();
    layout();
    if (S.needFit && S.rootCard && W > 1) { S.needFit = false; startView(false); }
    renderDetail(info);
    const { depth } = G().snapshot();
    $('#h2-note').textContent = S.rootCard ? `走査は深さ ${depth} まで(右のパネルで変更)` : '表示するフォルダがありません(ルートの設定やフィルターを確認してください)';
    kick();
  }
  function setOrigin(id) {
    S.origin = id;
    S.expanded = new Set();
    S.needFit = true;
    render();
  }

  // ---- 操作:1 本指(マウス)で移動、カードの上ならつかむ、2 本指・Ctrl+ホイールで拡大縮小、ホイールで移動 ----
  const pointers = new Map();
  let g = null;
  const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function onDown(e) {
    if (e.button) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 1) {
      const [x, y] = local(e);
      const c = cardAt(x, y);
      g = { c, x0: x, y0: y, x, y, moved: false };
    } else if (pointers.size === 2) {
      endDrag();
      const [a, b] = [...pointers.values()];
      g = { pinch: true, d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, k0: S.t.k, moved: true };
    }
  }
  function onMove(e) {
    const p = local(e);
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') canvas.style.cursor = cardAt(p[0], p[1]) ? 'pointer' : '';
      return;
    }
    pointers.set(e.pointerId, p);
    if (!g) return;
    if (g.pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (g.k0 * Math.hypot(a[0] - b[0], a[1] - b[1]) / g.d0) / S.t.k);
      return;
    }
    if (g.pinch) return;
    const dx = p[0] - g.x; const dy = p[1] - g.y;
    g.x = p[0]; g.y = p[1];
    if (!g.moved && Math.hypot(p[0] - g.x0, p[1] - g.y0) > 6) {
      g.moved = true;
      if (g.c && !g.c.isMore) { // カードと、その先につながるカードをまとめて引っぱる
        const set = new Set();
        (function add(c) { set.add(c); for (const k of c.kids || []) add(k); }(g.c));
        S.drag = { set, dx: 0, dy: 0, x0: g.x0, y0: g.y0 };
        canvas.style.cursor = 'grabbing';
      }
    }
    if (!g.moved) return;
    if (S.drag) {
      S.drag.dx = (p[0] - S.drag.x0) / S.t.k; S.drag.dy = (p[1] - S.drag.y0) / S.t.k;
      for (const c of S.drag.set) { c.x = c.tx + S.drag.dx; c.y = c.ty + S.drag.dy; }
    } else {
      S.t = { ...S.t, x: S.t.x + dx, y: S.t.y + dy };
    }
    kick();
  }
  function endDrag() { if (S.drag) { S.drag = null; canvas.style.cursor = ''; kick(); } } // 離すと元の位置へ戻る
  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    const tap = g && !g.pinch && !g.moved && e.type === 'pointerup';
    const c = g && g.c;
    endDrag();
    if (!pointers.size) g = null; else if (g && g.pinch) g = { pinch: true, moved: true };
    if (!tap || !c) return;
    if (c.isMore) { // 「ほか N 件」で広げる・「たたむ」で戻す
      if (S.expanded.has(c.pid)) S.expanded.delete(c.pid); else S.expanded.add(c.pid);
      render();
    } else if (c.n.kind === 'hub') {
      setOrigin(null);
    } else if (c !== S.rootCard) {
      setOrigin(c.n.id); // タップしたフォルダを起点にする
    }
  }
  function onWheel(e) {
    e.preventDefault();
    const [x, y] = local(e);
    if (e.ctrlKey || e.metaKey) zoomAt(x, y, Math.exp(-e.deltaY * 0.01));
    else { S.t = { ...S.t, x: S.t.x - e.deltaX, y: S.t.y - e.deltaY }; kick(); }
  }

  function renderLevels() {
    for (const b of document.querySelectorAll('#h2-levels [data-lv]')) b.classList.toggle('on', Number(b.dataset.lv) === S.levels);
  }

  function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'launch') G().launch(b.dataset.path);
    else if (act === 'open-session') G().openSession(b.dataset.id);
    else if (act === 'focus') { S.origin = null; S.needFit = true; G().focusFolder(b.dataset.path); }
    else if (act === 'focus3d') { G().setView('3d'); G().focusFolder(b.dataset.path); }
    else if (act === 'origin-reset') setOrigin(null);
    else if (act === 'origin-up') {
      const n = S.rootCard && S.rootCard.n;
      setOrigin(!n || n.kind === 'root' || !n.parent ? null : n.parent); // ルートの上は HOME(絞り込みではそのルート)
    } else if (act === 'expand-all') {
      S.expanded = new Set(S.cards.filter((c) => c.isMore).map((c) => c.pid));
      render();
    } else if (act === 'collapse-all') { S.expanded = new Set(); render(); }
    else if (act === 'fit') startView(true);
    else if (act === 'home-view') startView(false);
  }

  function init() {
    canvas = $('#h2-canvas');
    ctx = canvas.getContext('2d');
    $('#home2d').addEventListener('click', onClick);
    $('#h2-sort').value = S.sort;
    $('#h2-sort').addEventListener('change', (e) => { S.sort = e.target.value; store.set('h2Sort', S.sort); render(); });
    $('#h2-levels').addEventListener('click', (e) => {
      const b = e.target.closest('[data-lv]');
      if (!b) return;
      S.levels = Number(b.dataset.lv);
      store.set('h2Levels', S.levels);
      renderLevels();
      S.needFit = true;
      render();
    });
    renderLevels();
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    if (window.ResizeObserver) new ResizeObserver(() => { const first = W <= 1; resize(); if (first) render(); }).observe(canvas.parentElement);
    resize();
    // 走査し直しやモード切り替え(ホーム ⇄ 絞り込み)のときは、起点を戻して左上から見せる
    let lastKey = '';
    G().onChange(() => {
      const { mode, focus } = G().snapshot();
      const key = `${mode}|${focus || ''}`;
      if (key !== lastKey) { lastKey = key; S.origin = null; S.expanded = new Set(); S.needFit = true; }
      resize();
      render();
    });
    render();
  }

  window.Home2DView = { init, render };
}());
