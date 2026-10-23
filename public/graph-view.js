'use strict';
// ホーム画面: フォルダ構造の 3D グラフ(Claude セッションも同じ空間に表示する)
// 依存: ForceGraph3D / THREE / SpriteText / d3f(public/vendor/graph3d.bundle.js)

(function () {
  const $ = (s) => document.querySelector(s);
  const HUB = '__home__';
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));

  const CAT_COLORS = {
    'JS/TS': '#f2c94c', Python: '#4f9fe8', Go: '#5fd0d0', Rust: '#c9764a', 'Java/Kotlin': '#e07b7b',
    'C/C++': '#9b8cf0', 'C#': '#8e6fd6', 'Ruby/PHP': '#e060a8', Shell: '#8fbf7f', Web: '#f08a5d',
    Docs: '#cfc8bf', Config: '#7f8c99', Media: '#d38ad8', Other: '#6f665e',
  };
  const DEPTH_COLORS = ['#f2c94c', '#f08a5d', '#d97757', '#c9647a', '#9b8cf0', '#6fb8b0', '#8fbf7f'];
  const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, "Noto Sans Mono CJK JP", "Hiragino Sans", "Yu Gothic", sans-serif';
  const STATUS_JA = { starting: '起動中', idle: '待機中', working: '作業中', waiting: '入力待ち', done: '完了', error: 'エラー', exited: '終了' };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('ja-JP');
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* ignore */ } },
  };

  // ---- パス操作(Windows / POSIX 両対応) ----
  const normPath = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const keyPath = (p) => { const n = normPath(p); return /^[a-zA-Z]:/.test(n) || n.startsWith('//') ? n.toLowerCase() : n; };
  function dirnameOf(p) {
    const t = p.replace(/[\\/]+$/, '');
    const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
    if (i < 0) return p;
    if (i === 0) return t.slice(0, 1);
    if (/^[a-zA-Z]:$/.test(t.slice(0, i))) return t.slice(0, i) + t[i];
    return t.slice(0, i);
  }
  const baseOf = (p) => { const t = p.replace(/[\\/]+$/, ''); return t.slice(Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\')) + 1) || p; };
  function ancestors(p) {
    const list = [];
    let cur = p;
    for (let i = 0; i < 40; i++) {
      list.unshift({ name: baseOf(cur), path: cur });
      const up = dirnameOf(cur);
      if (up === cur) break;
      cur = up;
    }
    return list;
  }

  // ---- 状態 ----
  const saved = store.get('gSettings', {});
  const S = {
    roots: store.get('gRoots', []),
    mode: 'home',
    focus: null,
    depth: { home: 2, focus: 2 }, // 開いたときは毎回 2 から(保存した値は使わない)
    rel: {
      home: { contains: true, import: false, session: true, ...((saved.rel || {}).home || {}) },
      focus: { contains: true, import: true, session: true, ...((saved.rel || {}).focus || {}) },
    },
    f: {
      search: '', searchOnly: false, disabledCats: new Set(saved.disabledCats || []), minFiles: 0,
      onlySessions: false, hidden: false, ignored: false, labels: true, pin: false, color: 'cat',
      ...(saved.f || {}),
    },
    raw: null,
    rawImports: false,
    sessions: [],
    sessionSig: '',
    nodes: [],
    links: [],
    objs: new Map(),
    adj: new Map(),
    hover: null,
    hl: null,
    cardNode: null,
    token: 0,
    graph: null,
    host: null,
    opts: {},
    suggested: [],
    visible: false,
    fitPending: false,
    loadedOnce: false,
    panelCollapsed: !!saved.panelCollapsed,
  };
  S.f.search = '';
  S.f.disabledCats = new Set(S.f.disabledCats);

  const curRel = () => S.rel[S.mode];
  function persist() {
    store.set('gSettings', {
      rel: S.rel, disabledCats: [...S.f.disabledCats], panelCollapsed: S.panelCollapsed,
      f: { searchOnly: S.f.searchOnly, minFiles: S.f.minFiles, onlySessions: S.f.onlySessions, hidden: S.f.hidden, ignored: S.f.ignored, labels: S.f.labels, pin: S.f.pin, color: S.f.color },
    });
  }

  // ---- 見た目 ----
  const lerpHex = (a, b, t) => {
    const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
    const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
    return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
  };
  function colorOf(n) {
    if (n.kind === 'hub') return '#d97757';
    if (S.f.color === 'depth') return DEPTH_COLORS[Math.max(0, n.depth) % DEPTH_COLORS.length];
    if (S.f.color === 'size') return lerpHex('#4a423c', '#ffb27a', Math.min(1, Math.log10(1 + n.totalFiles) / 3.5));
    return CAT_COLORS[n.cat] || CAT_COLORS.Other;
  }
  function radiusOf(n) {
    if (n.kind === 'hub') return 8;
    if (n.kind === 'session') return 7;
    const base = Math.min(10, 2.2 + Math.log2(1 + n.totalFiles) * 0.75);
    return n.kind === 'root' ? base * 1.35 + 1 : base;
  }
  const geoCache = new Map();
  function geoFor(r) {
    const k = Math.round(r * 2);
    if (!geoCache.has(k)) geoCache.set(k, new THREE.SphereGeometry(k / 2, 14, 12));
    return geoCache.get(k);
  }
  const texCache = new Map();
  function statusTexture(status) {
    const k = STATUS_JA[status] ? status : 'idle';
    if (!texCache.has(k)) {
      const t = new THREE.TextureLoader().load(S.opts.mascotURL(k));
      t.colorSpace = THREE.SRGBColorSpace;
      texCache.set(k, t);
    }
    return texCache.get(k);
  }
  const labelWanted = (n) => S.f.labels && (n.kind === 'session' || n.kind === 'hub' || n.kind === 'root' || S.nodes.length <= 220 || n.depth <= 1);
  const STATUS_COLORS = { starting: '#d77757', idle: '#d77757', working: '#4ea1ff', waiting: '#ffc53d', done: '#3fc56b', error: '#ff4d5e', exited: '#6e6862' };

  function makeLabel(text, h, color) {
    const t = new SpriteText(text, h, color);
    t.fontFace = FONT;
    t.fontWeight = '600';
    t.strokeWidth = 1.2;
    t.strokeColor = '#0a0a0a';
    t.material.depthWrite = false;
    return t;
  }

  // 発光(放射グラデーションのスプライトを加算合成で重ねる)
  let glowTex = null;
  function glowTexture() {
    if (glowTex) return glowTex;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const gr = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.18, 'rgba(255,255,255,0.55)');
    gr.addColorStop(0.45, 'rgba(255,255,255,0.14)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, 128, 128);
    glowTex = new THREE.CanvasTexture(c);
    glowTex.colorSpace = THREE.SRGBColorSpace;
    return glowTex;
  }
  function makeGlow(color, size, opacity) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    sp.scale.set(size, size, 1);
    sp.__base = { size, opacity };
    return sp;
  }
  function makeRing(radius, tube, color, opacity) {
    const m = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 6, 96),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending }));
    return m;
  }

  function nodeObject(n) {
    const g = new THREE.Group();
    n.__r = radiusOf(n);
    n.__label = null;
    n.__mat = null;
    n.__sprite = null;
    n.__glow = null;
    n.__spin = null;
    if (n.kind === 'session') {
      const glow = makeGlow(STATUS_COLORS[n.status] || STATUS_COLORS.idle, 28, 0.35);
      g.add(glow);
      n.__glow = glow;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: statusTexture(n.status), transparent: true, depthWrite: false }));
      sp.scale.set(13, 13, 1);
      g.add(sp);
      n.__sprite = sp;
      n.__spriteStatus = n.status;
      const l = makeLabel(n.name, 3.4, '#f2c9b5');
      l.position.y = -10;
      g.add(l);
      n.__label = l;
      return g;
    }
    const col = colorOf(n);
    const mat = new THREE.MeshLambertMaterial({ color: col, transparent: true, opacity: 1, emissive: col, emissiveIntensity: 0.22 });
    const big = n.kind === 'hub' || n.kind === 'root';
    // 本体は小さめの光点にして、周囲の発光で大きさを見せる
    g.add(new THREE.Mesh(geoFor(n.__r * (big ? 0.62 : 0.5)), mat));
    n.__mat = mat;
    const glow = makeGlow(col, n.__r * (big ? 6.5 : 5.5), big ? 0.38 : 0.3);
    g.add(glow);
    n.__glow = glow;
    if (big) {
      // 周回リング(ハブは 2 本、ルートは 1 本)
      const rings = [];
      const r1 = makeRing(n.__r * 1.25, n.kind === 'hub' ? 0.14 : 0.1, col, 0.6);
      r1.rotation.x = Math.PI / 2.4;
      rings.push(r1);
      if (n.kind === 'hub') {
        const r2 = makeRing(n.__r * 1.7, 0.08, '#f2c94c', 0.4);
        r2.rotation.x = -Math.PI / 3;
        r2.rotation.y = Math.PI / 5;
        rings.push(r2);
      }
      rings.forEach((r) => g.add(r));
      n.__spin = rings;
    }
    if (labelWanted(n)) {
      const h = n.kind === 'hub' ? 7 : n.kind === 'root' ? 5 : n.depth <= 1 ? 4 : 3.2;
      const l = makeLabel(n.kind === 'hub' ? 'HOME' : n.name, h, n.kind === 'folder' ? '#bdb3a9' : '#e8b8a0');
      l.position.y = n.__r * (big ? 1.8 : 0.6) + h * 0.7 + 1.5;
      g.add(l);
      n.__label = l;
    }
    return g;
  }

  // ---- 背景演出(星空 / ジオデシック球 / HUD リング / 中心の星雲) ----
  const decor = { group: null, shell: null, ring: null, ring2: null, nebula: null, stars: null, center: [0, 0, 0], radius: 120, cur: { r: 120, c: [0, 0, 0] } };
  const rand = (a, b) => a + Math.random() * (b - a);
  const gauss = () => { let u = 0; let v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  function pointsOf(positions, colors, size, opacity) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return new THREE.Points(geo, new THREE.PointsMaterial({
      size, vertexColors: true, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, map: glowTexture(), sizeAttenuation: true,
    }));
  }
  function buildDecor(scene) {
    const root = new THREE.Group();
    decor.group = root;

    // 星空(カメラから十分遠い球殻に散らす)
    const sp = []; const sc = [];
    const tints = [[1, 0.95, 0.9], [1, 0.72, 0.55], [0.75, 0.7, 1], [0.6, 0.9, 0.9]];
    for (let i = 0; i < 2600; i++) {
      const y = rand(-1, 1); const th = rand(0, Math.PI * 2); const r = Math.sqrt(1 - y * y); const d = rand(1400, 3200);
      sp.push(Math.cos(th) * r * d, y * d, Math.sin(th) * r * d);
      const t = tints[Math.random() < 0.7 ? 0 : 1 + Math.floor(Math.random() * 3)]; const b = rand(0.25, 0.9);
      sc.push(t[0] * b, t[1] * b, t[2] * b);
    }
    decor.stars = pointsOf(sp, sc, 16, 0.9);
    scene.add(decor.stars);

    // ジオデシック球(辺 + 頂点)
    const ico = new THREE.IcosahedronGeometry(1, 2);
    const shell = new THREE.Group();
    shell.add(new THREE.LineSegments(new THREE.EdgesGeometry(ico, 1),
      new THREE.LineBasicMaterial({ color: '#6a5446', transparent: true, opacity: 0.3, depthWrite: false })));
    const vp = ico.getAttribute('position').array;
    shell.add(pointsOf(Array.from(vp), Array.from(vp, () => 0.6), 2.2, 0.8));
    decor.shell = shell;
    root.add(shell);

    // HUD リング(目盛り付き)と点線リング
    const ring = new THREE.Group();
    const circ = [];
    for (let i = 0; i < 256; i++) { const a = (i / 256) * Math.PI * 2; circ.push(Math.cos(a), 0, Math.sin(a)); }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(circ, 3));
    ring.add(new THREE.LineLoop(cg, new THREE.LineBasicMaterial({ color: '#d97757', transparent: true, opacity: 0.35, depthWrite: false })));
    const ticks = [];
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2; const len = i % 10 === 0 ? 0.05 : 0.018;
      ticks.push(Math.cos(a), 0, Math.sin(a), Math.cos(a) * (1 + len), 0, Math.sin(a) * (1 + len));
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(ticks, 3));
    ring.add(new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: '#f08a5d', transparent: true, opacity: 0.5, depthWrite: false })));
    decor.ring = ring;
    root.add(ring);
    const dots = []; const dc = [];
    for (let i = 0; i < 180; i++) { const a = (i / 180) * Math.PI * 2; dots.push(Math.cos(a), 0, Math.sin(a)); dc.push(0.85, 0.47, 0.34); }
    decor.ring2 = pointsOf(dots, dc, 2.4, 0.8);
    decor.ring2.rotation.x = 0.35;
    root.add(decor.ring2);

    // 中心の星雲(色はカテゴリの配色から)
    const np = []; const nc = [];
    const pal = ['#f08a5d', '#d97757', '#9b8cf0', '#5fd0d0', '#f2c94c', '#e060a8', '#8fbf7f'].map((h) => new THREE.Color(h));
    for (let i = 0; i < 1800; i++) {
      const k = Math.floor(Math.random() * pal.length);
      const off = [Math.cos(k * 0.9) * 0.35, Math.sin(k * 1.7) * 0.25, Math.sin(k * 0.9) * 0.35];
      np.push((gauss() * 0.42 + off[0]), (gauss() * 0.34 + off[1]), (gauss() * 0.42 + off[2]));
      const b = rand(0.35, 1);
      nc.push(pal[k].r * b, pal[k].g * b, pal[k].b * b);
    }
    decor.nebula = pointsOf(np, nc, 2.6, 0.6);
    root.add(decor.nebula);

    scene.add(root);
  }
  function measureGraph() {
    const pts = S.nodes.filter((n) => n.x != null && n.kind !== 'session');
    if (!pts.length) return;
    const c = [0, 0, 0];
    for (const n of pts) { c[0] += n.x; c[1] += n.y; c[2] += n.z; }
    c.forEach((v, i) => { c[i] = v / pts.length; });
    const d = pts.map((n) => Math.hypot(n.x - c[0], n.y - c[1], n.z - c[2])).sort((a, b) => a - b);
    decor.center = c;
    decor.radius = Math.max(70, d[Math.floor(d.length * 0.92)] || 0);
  }
  function animateDecor(t) {
    if (!decor.group) return;
    const k = 0.04;
    decor.cur.r += (decor.radius - decor.cur.r) * k;
    decor.cur.c = decor.cur.c.map((v, i) => v + (decor.center[i] - v) * k);
    const R = decor.cur.r;
    decor.group.position.set(...decor.cur.c);
    decor.shell.scale.setScalar(R * 1.35);
    decor.shell.rotation.y = t * 0.00004;
    decor.shell.rotation.x = Math.sin(t * 0.00002) * 0.2;
    decor.ring.scale.setScalar(R * 1.7);
    decor.ring.rotation.y = -t * 0.00006;
    decor.ring.rotation.x = 0.18 + Math.sin(t * 0.00015) * 0.04;
    decor.ring2.scale.setScalar(R * 1.55);
    decor.ring2.rotation.y = t * 0.00009;
    const nr = Math.max(18, R * 0.22);
    decor.nebula.scale.setScalar(nr);
    decor.nebula.rotation.y = t * 0.00012;
    decor.stars.rotation.y = t * 0.000008;
  }
  function animateNodes(t) {
    for (const n of S.nodes) {
      if (n.__spin) n.__spin.forEach((r, i) => { r.rotation.z = t * (i ? -0.0005 : 0.0007); });
      const gl = n.__glow;
      if (!gl) continue;
      let s = gl.__base.size;
      if (n.kind === 'hub') s *= 1 + Math.sin(t * 0.002) * 0.08;
      if (n.kind === 'session' && (n.status === 'working' || n.status === 'waiting')) {
        s *= 1 + Math.sin(t * (n.status === 'waiting' ? 0.006 : 0.004)) * 0.18;
      }
      if (S.hover === n) s *= 1.45;
      gl.scale.set(s, s, 1);
    }
  }
  let rafId = 0;
  let lastMeasure = 0;
  function tick(t) {
    rafId = 0;
    if (!S.visible) return;
    if (t - lastMeasure > 800) { lastMeasure = t; measureGraph(); }
    animateDecor(t);
    animateNodes(t);
    rafId = requestAnimationFrame(tick);
  }
  const startLoop = () => { if (!rafId) rafId = requestAnimationFrame(tick); };

  // ---- 初期配置(半径方向に広げる木構造レイアウト。これを力学シミュレーションで仕上げる) ----
  function layoutRadial(objs) {
    const byId = new Map(objs.map((o) => [o.id, o]));
    const kids = new Map();
    const tops = [];
    for (const o of objs) {
      const p = o.parent && byId.has(o.parent) ? o.parent : null;
      if (p) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(o); } else tops.push(o);
    }
    const setPos = (o, x, y, z) => { o.x = x; o.y = y; o.z = z; o.vx = 0; o.vy = 0; o.vz = 0; o.fx = undefined; o.fy = undefined; o.fz = undefined; o.__pinned = false; };
    const basis = (u) => {
      const h = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      let v = cr(u, h);
      const l = Math.hypot(...v) || 1;
      v = v.map((c) => c / l);
      return [v, cr(u, v)];
    };
    const place = (o, pos, dir, level) => {
      const list = (kids.get(o.id) || []).sort((a, b) => b.totalFiles - a.totalFiles);
      const n = list.length;
      if (!n) return;
      const R = level === 0 ? 34 + 7 * Math.sqrt(n) : Math.max(13, 44 * Math.pow(0.74, level));
      const alpha = Math.min(1.35, 0.66 + 0.056 * (n - 1));
      const [v, w] = dir ? basis(dir) : [null, null];
      list.forEach((c, i) => {
        let d;
        if (level === 0) { // 最上位は全方位に均等配置(フィボナッチ球)
          const y = n === 1 ? 0 : 1 - (2 * (i + 0.5)) / n;
          const r = Math.sqrt(Math.max(0, 1 - y * y));
          d = [Math.cos(i * GOLDEN) * r, y, Math.sin(i * GOLDEN) * r];
        } else { // 親の向きを中心にした円錐状に広げる
          const th = n === 1 ? 0 : alpha * Math.sqrt((i + 0.5) / n);
          const ph = i * GOLDEN;
          const ct = Math.cos(th); const st = Math.sin(th);
          d = [0, 1, 2].map((k) => dir[k] * ct + (v[k] * Math.cos(ph) + w[k] * Math.sin(ph)) * st);
        }
        const p = [pos[0] + d[0] * R, pos[1] + d[1] * R, pos[2] + d[2] * R];
        setPos(c, p[0], p[1], p[2]);
        place(c, p, d, level + 1);
      });
    };
    if (tops.length === 1) {
      setPos(tops[0], 0, 0, 0);
      place(tops[0], [0, 0, 0], null, 0);
    } else {
      tops.forEach((t, i) => {
        const y = tops.length === 1 ? 0 : 1 - (2 * (i + 0.5)) / tops.length;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const d = [Math.cos(i * GOLDEN) * r, y, Math.sin(i * GOLDEN) * r];
        const p = d.map((c) => c * 60);
        setPos(t, p[0], p[1], p[2]);
        place(t, p, d, 1);
      });
    }
  }

  // ---- データ → グラフ ----
  function bestFolder(cwd, folders) {
    const c = keyPath(cwd);
    let best = null;
    let bl = -1;
    for (const f of folders) {
      const k = keyPath(f.id);
      if ((c === k || c.startsWith(`${k}/`)) && k.length > bl) { best = f.id; bl = k.length; }
    }
    return best;
  }

  function rebuild({ layout = false } = {}) {
    const raw = S.raw;
    if (!raw || !S.graph) return;
    const rel = curRel();
    const nodesRaw = raw.nodes;
    const byId = new Map(nodesRaw.map((n) => [n.id, n]));
    const parentOf = (n) => (n.kind === 'root' && S.mode === 'home' ? HUB : n.parent);

    // セッションがどのフォルダに属するか
    const folders = nodesRaw.filter((n) => n.kind === 'folder' || n.kind === 'root');
    const attach = new Map();
    const perFolder = new Map();
    for (const s of S.sessions) {
      if (!s.cwd) continue;
      let id = bestFolder(s.cwd, folders);
      if (!id && S.mode === 'home') id = HUB;
      if (!id) continue;
      attach.set(s.id, id);
      if (!perFolder.has(id)) perFolder.set(id, []);
      perFolder.get(id).push(s);
    }

    // フィルター(通ったノード + その祖先を残す)
    const q = S.f.search.trim().toLowerCase();
    const matches = (n) => n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q);
    const pass = (n) => {
      if (n.kind === 'hub' || n.kind === 'root') return true;
      if (S.f.disabledCats.has(n.cat)) return false;
      if (n.totalFiles < S.f.minFiles) return false;
      if (S.f.onlySessions && !perFolder.has(n.id)) return false;
      if (q && S.f.searchOnly && !matches(n)) return false;
      return true;
    };
    const keep = new Set();
    for (const n of nodesRaw) {
      if (!pass(n)) continue;
      let cur = n;
      while (cur && !keep.has(cur.id)) {
        keep.add(cur.id);
        const pid = parentOf(cur);
        cur = pid ? byId.get(pid) : null;
      }
    }

    // ノードオブジェクト(位置を保つため使い回す)
    const out = [];
    for (const n of nodesRaw) {
      if (!keep.has(n.id)) continue;
      let o = S.objs.get(n.id);
      if (!o) { o = { id: n.id }; S.objs.set(n.id, o); }
      Object.assign(o, {
        kind: n.kind, name: n.name, depth: n.depth, files: n.files, totalFiles: n.totalFiles, dirs: n.dirs, more: n.more,
        cat: n.cat, cats: n.cats, topExts: n.topExts, parent: parentOf(n), unreadable: n.unreadable,
      });
      o.__match = !!q && matches(n);
      out.push(o);
    }
    const folderObjs = out.slice();

    const links = [];
    for (const l of raw.links) {
      if (!keep.has(l.source) || !keep.has(l.target)) continue;
      if (l.type === 'import' && !rel.import) continue;
      links.push({ source: l.source, target: l.target, type: l.type, weight: l.weight || 1 });
    }

    // セッション(同じ空間に表示)
    if (rel.session) {
      for (const s of S.sessions) {
        let at = attach.get(s.id);
        while (at && !keep.has(at)) { const nn = byId.get(at); const pid = nn && parentOf(nn); at = pid || null; }
        if (!at) continue;
        const sid = `session:${s.id}`;
        let o = S.objs.get(sid);
        if (!o) {
          o = { id: sid };
          S.objs.set(sid, o);
          const host = S.objs.get(at);
          if (host && host.x != null) { o.x = host.x + (Math.random() - 0.5) * 14; o.y = host.y + 10; o.z = host.z + (Math.random() - 0.5) * 14; }
        }
        Object.assign(o, { kind: 'session', name: s.name, sessionId: s.id, status: s.status, cwd: s.cwd, depth: 99, totalFiles: 0, agents: s.agents || [] });
        o.__match = false;
        out.push(o);
        links.push({ source: at, target: sid, type: 'session', weight: 1 });
      }
    }

    // 位置: 再配置時は放射状レイアウト、それ以外は新規ノードだけ親の近くへ
    if (layout) layoutRadial(folderObjs);
    else {
      for (const o of out) {
        if (o.x != null) continue;
        const p = o.parent && S.objs.get(o.parent);
        const b = p && p.x != null ? p : { x: 0, y: 0, z: 0 };
        o.x = b.x + (Math.random() - 0.5) * 24; o.y = b.y + (Math.random() - 0.5) * 24; o.z = b.z + (Math.random() - 0.5) * 24;
      }
    }
    if (layout) {
      for (const o of out) {
        if (o.kind !== 'session') continue;
        const l = links.find((k) => k.target === o.id);
        const h = l && S.objs.get(l.source);
        if (h && h.x != null) { o.x = h.x + (Math.random() - 0.5) * 16; o.y = h.y + 12; o.z = h.z + (Math.random() - 0.5) * 16; }
      }
    }

    S.nodes = out;
    S.links = links;
    S.adj = new Map();
    for (const l of links) {
      for (const [a, b] of [[l.source, l.target], [l.target, l.source]]) {
        if (!S.adj.has(a)) S.adj.set(a, new Set());
        S.adj.get(a).add(b);
      }
    }
    S.hover = null;
    S.hl = null;
    S.sessionSig = sessionSignature();

    S.graph.nodeThreeObject(nodeObject); // 色・ラベルの変更を反映するため作り直す
    S.graph.graphData({ nodes: out, links });
    S.graph.d3ReheatSimulation();
    if (layout) {
      S.fitPending = true;
      setTimeout(() => { if (S.visible) fitView(700); }, 700);
    }
    renderCrumbs();
    renderStats();
    renderCats();
    renderCard(null);
    $('#g-empty').classList.toggle('hidden', S.roots.length > 0 || S.mode === 'focus');
  }

  function sessionSignature() {
    return S.sessions.map((s) => `${s.id}@${s.cwd}`).join('|');
  }

  async function load({ layout = true } = {}) {
    const hasRoot = S.mode === 'focus' || S.roots.length > 0;
    if (!hasRoot) { // ルート未設定
      S.raw = { nodes: [{ id: HUB, name: 'HOME', parent: null, depth: -1, kind: 'hub', files: 0, totalFiles: 0, dirs: 0, more: 0, cat: 'Other', cats: {}, topExts: [] }], links: [], errors: [] };
      rebuild({ layout: true });
      return;
    }
    const token = ++S.token;
    const rel = curRel();
    $('#g-loading').classList.remove('hidden');
    const body = {
      depth: S.depth[S.mode], hidden: S.f.hidden, includeIgnored: S.f.ignored, imports: rel.import,
      ...(S.mode === 'focus' ? { focus: S.focus } : { roots: S.roots }),
    };
    try {
      const res = await fetch('/api/graph', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (token !== S.token) return; // 古い応答は捨てる
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      S.raw = data;
      S.rawImports = rel.import;
      rebuild({ layout });
    } catch (e) {
      if (token === S.token) setWarn(`読み込みに失敗しました: ${e.message}`);
    } finally {
      if (token === S.token) $('#g-loading').classList.add('hidden');
    }
  }

  // ---- 画面遷移(ホーム ⇄ フォルダ絞り込み) ----
  function resetView() {
    S.objs.clear();
    S.hover = null;
    S.hl = null;
    S.cardNode = null;
  }
  function focusFolder(path) {
    S.mode = 'focus';
    S.focus = path;
    resetView();
    syncRelUI();
    load({ layout: true });
  }
  function goHome() {
    S.mode = 'home';
    S.focus = null;
    resetView();
    syncRelUI();
    load({ layout: true });
  }
  function goUp() {
    if (S.mode !== 'focus') return;
    const isRoot = S.roots.some((r) => keyPath(r) === keyPath(S.focus));
    const up = dirnameOf(S.focus);
    if (isRoot || up === S.focus) goHome(); else focusFolder(up);
  }

  // ---- 表示(パンくず / 統計 / 種別 / 詳細カード) ----
  function setWarn(msg) {
    const el = $('#g-warn');
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }

  function renderCrumbs() {
    const el = $('#g-crumbs');
    const parts = [`<button class="crumb ${S.mode === 'home' ? 'cur' : ''}" data-go="home">ホーム</button>`];
    if (S.mode === 'focus' && S.focus) {
      let list = ancestors(S.focus);
      const rootIdx = list.findIndex((a) => S.roots.some((r) => keyPath(r) === keyPath(a.path)));
      if (rootIdx >= 0) list = list.slice(rootIdx);
      else if (list.length > 5) list = [{ name: '…', path: null }, ...list.slice(-5)];
      list.forEach((a, i) => {
        parts.push('<span class="sep">›</span>');
        const cur = i === list.length - 1;
        parts.push(`<button class="crumb ${cur ? 'cur' : ''}" ${a.path && !cur ? `data-path="${esc(a.path)}"` : ''} title="${esc(a.path || '')}">${esc(a.name)}</button>`);
      });
    }
    el.innerHTML = parts.join('');
  }

  function renderStats() {
    const folders = S.nodes.filter((n) => n.kind === 'folder' || n.kind === 'root').length;
    const imports = S.links.filter((l) => l.type === 'import').length;
    const sess = S.nodes.filter((n) => n.kind === 'session').length;
    const files = S.nodes.filter((n) => n.kind === 'root').reduce((a, n) => a + n.totalFiles, 0)
      || (S.mode === 'focus' ? (S.nodes.find((n) => n.kind === 'root') || {}).totalFiles || 0 : 0);
    const tile = (v, l, cls = '') => `<div class="g-stat ${cls}"><b>${fmt(v)}</b><span>${l}</span></div>`;
    $('#g-stats').innerHTML =
      tile(folders, 'FOLDERS') + tile(files, 'FILES') + tile(imports, 'DEPS') + tile(sess, 'SESSIONS', 'hot') +
      (S.raw && S.raw.took != null ? `<div class="g-stat-note">SCAN ${S.raw.took}ms</div>` : '');
    const msgs = [];
    if (S.raw && S.raw.truncated) msgs.push('上限に達したため一部のみ表示しています。深さを下げるか、フォルダを選んで絞り込んでください。');
    if (S.raw && S.raw.errors && S.raw.errors.length) msgs.push(S.raw.errors.map((e) => `${e.path}: ${e.error}`).join(' / '));
    setWarn(msgs.join('  '));
  }

  function renderCats() {
    const counts = new Map();
    for (const n of (S.raw ? S.raw.nodes : [])) {
      if (n.kind !== 'folder' && n.kind !== 'root') continue;
      counts.set(n.cat, (counts.get(n.cat) || 0) + 1);
    }
    const list = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    $('#g-cats').innerHTML = list.map(([c, k]) =>
      `<button class="chip ${S.f.disabledCats.has(c) ? 'off' : ''}" data-cat="${esc(c)}"><i style="background:${CAT_COLORS[c] || CAT_COLORS.Other}"></i>${esc(c)} <small>${k}</small></button>`).join('')
      || '<span class="g-note">データなし</span>';
  }

  function renderCard(node) {
    const el = $('#g-card');
    S.cardNode = node;
    if (!node) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    const close = '<button class="c-close" data-act="close" title="閉じる (Esc)">✕</button>';
    if (node.kind === 'session') {
      const run = (node.agents || []).filter((a) => a.status === 'running').length;
      el.innerHTML = close +
        `<div class="c-name">${esc(node.name)}</div><div class="c-path">${esc(node.cwd)}</div>` +
        `<div class="c-row"><span>状態</span><span>${esc(STATUS_JA[node.status] || node.status)}</span></div>` +
        `<div class="c-row"><span>サブエージェント</span><span>実行中 ${run} / 計 ${(node.agents || []).length}</span></div>` +
        `<div class="c-btns"><button class="btn primary" data-act="open-session" data-id="${esc(node.sessionId)}">ターミナルを開く</button></div>`;
      return;
    }
    if (node.kind === 'hub') {
      el.innerHTML = close + `<div class="c-name">HOME</div><div class="c-path">ルートフォルダ ${S.roots.length} 件</div>` +
        '<div class="c-btns"><button class="btn" data-act="roots">ルート設定</button></div>';
      return;
    }
    const sess = S.sessions.filter((s) => s.cwd && (keyPath(s.cwd) === keyPath(node.id) || keyPath(s.cwd).startsWith(`${keyPath(node.id)}/`)));
    const exts = (node.topExts || []).map(([e, k]) => `.${esc(e)} ${k}`).join(' / ') || '—';
    const cats = Object.entries(node.cats || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, k]) => `${esc(c)} ${k}`).join(' / ') || '—';
    el.innerHTML = close +
      `<div class="c-name">${esc(node.name)}</div><div class="c-path">${esc(node.id)}</div>` +
      `<div class="c-row"><span>ファイル</span><span>直下 ${fmt(node.files)} / 配下合計 ${fmt(node.totalFiles)}</span></div>` +
      `<div class="c-row"><span>サブフォルダ</span><span>${fmt(node.dirs)}${node.more ? `(うち ${fmt(node.more)} 件は未展開)` : ''}</span></div>` +
      `<div class="c-row"><span>主な言語</span><span>${esc(node.cat)}(${cats})</span></div>` +
      `<div class="c-row"><span>拡張子</span><span>${exts}</span></div>` +
      (node.unreadable ? '<div class="c-row"><span>注意</span><span>読み取れませんでした</span></div>' : '') +
      (sess.length ? `<div class="c-row"><span>セッション</span><span></span></div>${sess.map((s) =>
        `<div class="c-sess" data-act="open-session" data-id="${esc(s.id)}"><span class="mini">${S.opts.mascotSVG(s.status)}</span><span>${esc(s.name)}</span><span style="color:var(--muted)">${esc(STATUS_JA[s.status] || s.status)}</span></div>`).join('')}` : '') +
      '<div class="c-btns">' +
      `<button class="btn primary" data-act="launch" data-path="${esc(node.id)}">ここで Claude を起動</button>` +
      (S.mode === 'focus' && node.id === S.focus ? '' : `<button class="btn" data-act="focus" data-path="${esc(node.id)}">フォーカス</button>`) +
      `<button class="btn" data-act="copy" data-path="${esc(node.id)}">パスをコピー</button>` +
      (node.__pinned ? '<button class="btn" data-act="unpin">固定を解除</button>' : '') +
      '</div>';
  }

  // ---- ハイライト / スタイル更新 ----
  function restyle() {
    const q = S.f.search.trim().toLowerCase();
    const hl = S.hl;
    for (const n of S.nodes) {
      let a = 1;
      if (q && !S.f.searchOnly && n.kind !== 'session' && n.kind !== 'hub' && !n.__match) a = 0.16;
      if (hl && !hl.has(n.id)) a = Math.min(a, 0.18);
      if (n.__mat) {
        n.__mat.opacity = a;
        n.__mat.emissiveIntensity = q && n.__match ? 0.9 : (hl && hl.has(n.id) && S.hover === n ? 0.7 : 0.22);
      }
      if (n.__glow) n.__glow.material.opacity = n.__glow.__base.opacity * (a < 1 ? a * 0.6 : (q && n.__match ? 1.6 : 1));
      if (n.__sprite) n.__sprite.material.opacity = a;
      if (n.__label) n.__label.material.opacity = a;
    }
    refreshLinks();
  }
  const refreshLinks = () => {
    if (!S.graph) return;
    S.graph.linkColor(linkColor).linkWidth(linkWidth);
  };
  const lid = (x) => (typeof x === 'object' ? x.id : x);
  function linkColor(l) {
    const both = !S.hl || (S.hl.has(lid(l.source)) && S.hl.has(lid(l.target)));
    if (!both) return 'rgba(90,82,76,0.06)';
    const lit = !!S.hl;
    switch (l.type) {
      case 'import': return lit ? '#ffb27a' : 'rgba(240,138,93,0.85)';
      case 'session': return lit ? '#b5e0a5' : 'rgba(143,191,127,0.8)';
      case 'root': return lit ? '#f08a5d' : 'rgba(217,119,87,0.6)';
      default: return lit ? 'rgba(255,214,190,0.85)' : 'rgba(190,150,125,0.38)';
    }
  }
  // 流れる光の粒(大きいグラフでは親子リンクには付けない)
  function linkParticles(l) {
    if (l.type === 'import') return Math.min(3, 1 + Math.floor(Math.log2(l.weight || 1)));
    if (l.type === 'session') return 2;
    if (l.type === 'root') return 2;
    return S.links.length <= 400 ? 1 : 0;
  }
  function linkWidth(l) {
    if (l.type === 'import') return 0.5 + Math.log2(1 + (l.weight || 1)) * 0.4;
    if (l.type === 'session') return 0.7;
    if (l.type === 'root') return 0.9;
    return S.links.length > 1500 ? 0 : 0.14;
  }

  function onHover(node) {
    S.hover = node || null;
    S.hl = node ? new Set([node.id, ...(S.adj.get(node.id) || [])]) : null;
    if (S.host) S.host.style.cursor = node ? 'pointer' : '';
    restyle();
  }

  // 全体表示(ノードの座標から外接球を求めて、今の向きのまま引く。getGraphBbox は描画前だと原点に集まって見えるため使わない)
  function fitView(ms = 700) {
    const pts = S.nodes.filter((n) => n.x != null);
    if (!pts.length || !S.graph) return;
    const c = [0, 0, 0];
    for (const n of pts) { c[0] += n.x; c[1] += n.y; c[2] += n.z; }
    c.forEach((v, i) => { c[i] = v / pts.length; });
    const R = Math.max(40, ...pts.map((n) => Math.hypot(n.x - c[0], n.y - c[1], n.z - c[2]) + (n.__r || 4) * 2));
    const cam = S.graph.camera();
    const half = (cam.fov * Math.PI) / 360;
    const fit = Math.min(half, Math.atan(Math.tan(half) * cam.aspect));
    const dist = (R / Math.sin(fit)) * 1.08;
    const t = S.graph.controls().target;
    let d = [cam.position.x - t.x, cam.position.y - t.y, cam.position.z - t.z];
    const l = Math.hypot(...d);
    d = l > 1e-3 ? d.map((v) => v / l) : [0.2, 0.3, 0.93];
    S.graph.cameraPosition({ x: c[0] + d[0] * dist, y: c[1] + d[1] * dist, z: c[2] + d[2] * dist }, { x: c[0], y: c[1], z: c[2] }, ms);
  }

  function flyTo(node) {
    if (!node || node.x == null) return;
    const dist = 90;
    const hyp = Math.hypot(node.x, node.y, node.z) || 1;
    const ratio = 1 + dist / hyp;
    S.graph.cameraPosition({ x: node.x * ratio, y: node.y * ratio, z: node.z * ratio }, node, 900);
  }

  // ---- セッション連携 ----
  function setSessions(list) {
    S.sessions = list || [];
    if (!S.raw || !S.graph) return;
    if (sessionSignature() !== S.sessionSig) { rebuild({ layout: false }); return; }
    let changed = false;
    for (const n of S.nodes) {
      if (n.kind !== 'session') continue;
      const s = S.sessions.find((x) => x.id === n.sessionId);
      if (!s) continue;
      if (s.status !== n.status) {
        n.status = s.status;
        if (n.__sprite) n.__sprite.material.map = statusTexture(s.status);
        if (n.__glow) n.__glow.material.color.set(STATUS_COLORS[s.status] || STATUS_COLORS.idle);
        changed = true;
      }
      n.name = s.name;
      n.agents = s.agents || [];
    }
    if (changed && S.cardNode && S.cardNode.kind !== 'folder') renderCard(S.cardNode);
  }

  // ---- UI ----
  function syncRelUI() {
    const r = curRel();
    $('#g-rel-contains').checked = r.contains;
    $('#g-rel-import').checked = r.import;
    $('#g-rel-session').checked = r.session;
    $('#g-depth').value = S.depth[S.mode];
    $('#g-depth-v').textContent = S.depth[S.mode];
  }

  function applyLinkVisibility() {
    S.graph.linkVisibility((l) => l.type !== 'contains' || curRel().contains);
  }

  function openRootsDialog() {
    $('#roots-text').value = S.roots.join('\n');
    const sug = $('#roots-suggest');
    sug.innerHTML = S.suggested.map((p) => `<button type="button" class="chip" data-add="${esc(p)}" title="${esc(p)}">${esc(baseOf(p) || p)}</button>`).join('') || '<span class="g-note">候補なし</span>';
    $('#dlg-roots').showModal();
  }

  function bindUI() {
    let t;
    const debounce = (fn, ms) => (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };

    $('#g-search').addEventListener('input', debounce((e) => {
      S.f.search = e.target.value;
      if (S.f.searchOnly) rebuild({ layout: false });
      else { for (const n of S.nodes) n.__match = !!S.f.search.trim() && (n.name.toLowerCase().includes(S.f.search.trim().toLowerCase()) || n.id.toLowerCase().includes(S.f.search.trim().toLowerCase())); restyle(); }
    }, 140));
    $('#g-search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const m = S.nodes.find((n) => n.__match && n.kind !== 'session'); if (m) flyTo(m); }
      if (e.key === 'Escape') { e.target.value = ''; S.f.search = ''; e.target.blur(); if (S.f.searchOnly) rebuild({ layout: false }); else { for (const n of S.nodes) n.__match = false; restyle(); } e.stopPropagation(); }
    });
    $('#g-search-only').checked = S.f.searchOnly;
    $('#g-search-only').addEventListener('change', (e) => { S.f.searchOnly = e.target.checked; persist(); rebuild({ layout: false }); });

    $('#g-rel-contains').addEventListener('change', (e) => { curRel().contains = e.target.checked; persist(); applyLinkVisibility(); S.graph.refresh(); });
    $('#g-rel-session').addEventListener('change', (e) => { curRel().session = e.target.checked; persist(); rebuild({ layout: false }); });
    $('#g-rel-import').addEventListener('change', (e) => {
      curRel().import = e.target.checked; persist();
      if (e.target.checked && !S.rawImports) load({ layout: false }); else rebuild({ layout: false });
    });

    $('#g-cats').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      const c = b.dataset.cat;
      if (S.f.disabledCats.has(c)) S.f.disabledCats.delete(c); else S.f.disabledCats.add(c);
      persist(); renderCats(); rebuild({ layout: false });
    });

    $('#g-depth').addEventListener('input', (e) => { $('#g-depth-v').textContent = e.target.value; });
    $('#g-depth').addEventListener('change', (e) => { S.depth[S.mode] = Number(e.target.value); persist(); load({ layout: true }); });
    $('#g-minfiles').value = S.f.minFiles;
    $('#g-minfiles-v').textContent = S.f.minFiles;
    $('#g-minfiles').addEventListener('input', (e) => { $('#g-minfiles-v').textContent = e.target.value; });
    $('#g-minfiles').addEventListener('change', (e) => { S.f.minFiles = Number(e.target.value); persist(); rebuild({ layout: false }); });

    const bindChk = (id, key, then) => {
      const el = $(id);
      el.checked = !!S.f[key];
      el.addEventListener('change', (e) => { S.f[key] = e.target.checked; persist(); then && then(); });
    };
    bindChk('#g-only-sessions', 'onlySessions', () => rebuild({ layout: false }));
    bindChk('#g-hidden', 'hidden', () => load({ layout: true }));
    bindChk('#g-ignored', 'ignored', () => load({ layout: true }));
    bindChk('#g-labels', 'labels', () => rebuild({ layout: false }));
    bindChk('#g-pin', 'pin');
    $('#g-color').value = S.f.color;
    $('#g-color').addEventListener('change', (e) => { S.f.color = e.target.value; persist(); rebuild({ layout: false }); });

    $('#g-relayout').addEventListener('click', () => { rebuild({ layout: true }); });
    $('#g-fit').addEventListener('click', () => fitView(600));
    $('#g-roots').addEventListener('click', openRootsDialog);
    $('#g-empty-btn').addEventListener('click', openRootsDialog);

    const panel = $('#g-panel');
    panel.classList.toggle('collapsed', S.panelCollapsed);
    $('#g-panel-toggle').textContent = S.panelCollapsed ? '«' : '»';
    $('#g-panel-toggle').addEventListener('click', () => {
      S.panelCollapsed = !S.panelCollapsed;
      panel.classList.toggle('collapsed', S.panelCollapsed);
      $('#g-panel-toggle').textContent = S.panelCollapsed ? '«' : '»';
      persist();
    });

    $('#g-crumbs').addEventListener('click', (e) => {
      const b = e.target.closest('.crumb');
      if (!b) return;
      if (b.dataset.go === 'home') goHome();
      else if (b.dataset.path) focusFolder(b.dataset.path);
    });

    $('#g-card').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'close') renderCard(null);
      else if (act === 'launch') S.opts.onLaunch(b.dataset.path);
      else if (act === 'open-session') S.opts.onOpenSession(b.dataset.id);
      else if (act === 'focus') focusFolder(b.dataset.path);
      else if (act === 'copy') navigator.clipboard.writeText(b.dataset.path).catch(() => {});
      else if (act === 'roots') openRootsDialog();
      else if (act === 'unpin' && S.cardNode) {
        const n = S.cardNode;
        n.fx = n.fy = n.fz = undefined;
        n.__pinned = false;
        S.graph.d3ReheatSimulation();
        renderCard(n);
      }
    });

    // ルート設定ダイアログ
    $('#roots-suggest').addEventListener('click', (e) => {
      const b = e.target.closest('[data-add]');
      if (!b) return;
      const ta = $('#roots-text');
      const lines = ta.value.split('\n').map((x) => x.trim()).filter(Boolean);
      if (!lines.includes(b.dataset.add)) lines.push(b.dataset.add);
      ta.value = lines.join('\n');
    });
    $('#roots-cancel').addEventListener('click', () => $('#dlg-roots').close());
    $('#roots-form').addEventListener('submit', (e) => {
      e.preventDefault();
      S.roots = [...new Set($('#roots-text').value.split('\n').map((x) => x.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean))];
      store.set('gRoots', S.roots);
      $('#dlg-roots').close();
      S.mode = 'home';
      S.focus = null;
      resetView();
      syncRelUI();
      load({ layout: true });
    });

    window.addEventListener('keydown', (e) => {
      if (!S.visible || e.key !== 'Escape') return;
      if (document.querySelector('dialog[open]')) return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (S.cardNode) renderCard(null); else goUp();
    });

    syncRelUI();
  }

  function createGraph() {
    S.host = $('#graph3d');
    const g = ForceGraph3D({ rendererConfig: { antialias: true, powerPreference: 'high-performance' } })(S.host)
      .backgroundColor('#060505')
      .showNavInfo(false)
      .nodeThreeObject(nodeObject)
      .nodeLabel((n) => {
        if (n.kind === 'session') return `<div class="g-tip"><b>${esc(n.name)}</b><br><small>${esc(STATUS_JA[n.status] || n.status)}</small></div>`;
        if (n.kind === 'hub') return '<div class="g-tip"><b>HOME</b></div>';
        return `<div class="g-tip"><b>${esc(n.name)}</b><br><small>${fmt(n.totalFiles)} ファイル ・ ${esc(n.cat)}</small></div>`;
      })
      .linkColor(linkColor)
      .linkWidth(linkWidth)
      .linkOpacity(1)
      .linkDirectionalArrowLength((l) => (l.type === 'import' ? 3.4 : 0))
      .linkDirectionalArrowRelPos(0.93)
      .linkDirectionalParticles(linkParticles)
      .linkDirectionalParticleWidth((l) => (l.type === 'import' ? 1.3 : l.type === 'session' ? 1.1 : 0.7))
      .linkDirectionalParticleSpeed((l) => (l.type === 'contains' ? 0.0035 : 0.007))
      .linkDirectionalParticleColor((l) => (l.type === 'session' ? '#b5e0a5' : l.type === 'import' ? '#ffb27a' : '#f2a27a'))
      .linkCurvature((l) => (l.type === 'import' ? 0.24 : 0))
      .linkCurveRotation((l) => (l.__rot ?? (l.__rot = Math.random() * Math.PI * 2)))
      .enableNodeDrag(true)
      .d3AlphaDecay(0.028)
      .d3VelocityDecay(0.34)
      .cooldownTime(7000)
      .onNodeHover(onHover)
      .onNodeRightClick((n) => renderCard(n))
      .onNodeClick((n) => {
        if (n.kind === 'session') S.opts.onOpenSession(n.sessionId);
        else if (n.kind === 'hub') { if (S.mode !== 'home') goHome(); else renderCard(n); }
        else if (!(S.mode === 'focus' && n.id === S.focus)) focusFolder(n.id);
      })
      .onNodeDragEnd((n) => {
        if (S.f.pin) { n.fx = n.x; n.fy = n.y; n.fz = n.z; n.__pinned = true; } else { n.fx = n.fy = n.fz = undefined; n.__pinned = false; }
        if (S.cardNode === n) renderCard(n);
      })
      .onBackgroundClick(() => renderCard(null))
      .onEngineStop(() => { if (S.fitPending) { S.fitPending = false; if (S.visible) fitView(900); } });
    S.graph = g;

    // 力学シミュレーション(初期の放射状配置を崩さず、重なりを避けて仕上げる)
    g.d3Force('link')
      .distance((l) => {
        if (l.type === 'import') return 80;
        if (l.type === 'session') return 17;
        if (l.type === 'root') return 60;
        return Math.max(12, 46 * Math.pow(0.76, (l.target && l.target.depth) || 0));
      })
      .strength((l) => (l.type === 'import' ? 0.012 : l.type === 'session' ? 0.9 : l.type === 'root' ? 0.6 : 0.75));
    g.d3Force('charge').strength((n) => (n.kind === 'hub' ? -260 : n.kind === 'session' ? -30 : -45)).distanceMax(320);
    g.d3Force('collide', d3f.forceCollide((n) => (n.__r || radiusOf(n)) + 2.5).iterations(2));

    // 発光(ブルーム)と背景演出
    const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(S.host.clientWidth || 800, S.host.clientHeight || 600), 0.75, 0.5, 0.62);
    g.postProcessingComposer().addPass(bloom);
    buildDecor(g.scene());
    applyLinkVisibility();
    resize();
    new ResizeObserver(() => resize()).observe(S.host);
  }

  function resize() {
    if (!S.graph || !S.host) return;
    const w = S.host.clientWidth;
    const h = S.host.clientHeight;
    if (w > 0 && h > 0) S.graph.width(w).height(h);
  }

  // ---- 公開 API ----
  async function init(opts) {
    S.opts = opts;
    createGraph();
    bindUI();
    try {
      const d = await fetch('/api/defaults').then((r) => r.json());
      S.suggested = d.suggestedRoots || [];
    } catch (_) { /* ignore */ }
    if (!S.roots.length && S.suggested.length) { /* 初回は設定を促す(自動では広い範囲を走査しない) */ }
  }
  // HUD の時計
  function tickClock() {
    const el = $('#g-clock');
    if (!el || !S.visible) return;
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
    el.innerHTML = `<span>${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} (${w})</span><b>${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}</b>`;
  }
  setInterval(tickClock, 1000);

  function show() {
    tickClock();
    S.visible = true;
    resize();
    S.graph.resumeAnimation();
    startLoop();
    if (!S.loadedOnce) { S.loadedOnce = true; load({ layout: true }); }
  }
  function hide() {
    S.visible = false;
    if (S.graph) S.graph.pauseAnimation();
  }

  window.GraphView = { init, show, hide, setSessions, goHome, focusFolder, openRoots: openRootsDialog, _state: S };
}());
