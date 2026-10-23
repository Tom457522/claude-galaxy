'use strict';

const $ = (sel) => document.querySelector(sel);
const grid = $('#grid');
const emptyEl = $('#empty');
const layoutSel = $('#layout');
const dlg = $('#dlg');
const sidebar = $('#sidebar');
const sideList = $('#side-list');
const sideSummary = $('#side-summary');

/** @type {Map<string, Pane>} */
const panes = new Map();
/** @type {Map<string, SideRow>} */
const rows = new Map();
let focusedId = null;

const TITLE = 'Claude Galaxy';

const THEME = {
  background: '#0a0a0a',
  foreground: '#ece6df',
  cursor: '#d97757',
  cursorAccent: '#0a0a0a',
  selectionBackground: 'rgba(217, 119, 87, 0.35)',
  black: '#1a1a1a',
  brightBlack: '#6b625a',
  red: '#e5484d',
  green: '#8fbf7f',
  yellow: '#e5b567',
  blue: '#7aa2d6',
  magenta: '#c792b8',
  cyan: '#6fb8b0',
  white: '#ece6df',
  brightWhite: '#ffffff',
  brightRed: '#f26d71',
  brightGreen: '#a8d596',
  brightYellow: '#f2c97d',
  brightBlue: '#95b8e3',
  brightMagenta: '#d9aaca',
  brightCyan: '#8fcdc6',
};

// ---------- ステータス表示 ----------
const STATUS_LABEL = {
  starting: '起動中',
  idle: '待機中',
  working: '作業中',
  waiting: '入力待ち',
  done: '完了',
  error: 'エラー',
  exited: '終了',
};
const normStatus = (s) => (STATUS_LABEL[s] ? s : 'idle');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// 使用量(トークン・概算コスト)
function fmtTok(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
const fmtCost = (c) => (c > 0 && c < 0.01 ? '<$0.01' : `$${c.toFixed(2)}`);
const usageTokens = (u) => (u ? u.input + u.output + u.cacheWrite + u.cacheRead : 0);
function usageTip(u) {
  if (!usageTokens(u)) return '';
  const models = Object.entries(u.models || {}).map(([m, n]) => `  ${m}: ${fmtTok(n)}`).join('\n');
  return `概算コスト ${fmtCost(u.cost)}${u.unpriced ? `(単価不明の応答 ${u.unpriced} 件は含まず)` : ''}\n` +
    `入力 ${fmtTok(u.input)} / 出力 ${fmtTok(u.output)} / キャッシュ書込 ${fmtTok(u.cacheWrite)} / キャッシュ読込 ${fmtTok(u.cacheRead)}` +
    (models ? `\n${models}` : '');
}

function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${String(s % 60).padStart(2, '0')}秒`;
  return `${Math.floor(m / 60)}時間${m % 60}分`;
}

// ---------- キャラクター(32x32 のドット絵) ----------
// 状態ごとに目・記号・腕の位置と色(CSS の .st-* )が変わる。アニメーションも状態ごとに別。
const px = (x, y, w, h, cls) => `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
const eyes = (f) => f(8) + f(22); // 左目と右目(x は目の左端)
const FACES = {
  idle: eyes((x) => px(x, 10, 2, 4, 'eye')),
  working:
    eyes((x) => px(x, 12, 2, 2, 'eye') + px(x - 1, 10, 4, 1, 'eye')) +
    px(28, 3, 1, 2, 'sweat') + px(27, 5, 3, 1, 'sweat') +
    px(10, 1, 3, 3, 'dot d1') + px(15, 1, 3, 3, 'dot d2') + px(20, 1, 3, 3, 'dot d3'),
  waiting:
    eyes((x) => px(x, 10, 2, 4, 'eye')) +
    px(26, 0, 3, 1, 'mark') + px(28, 1, 1, 1, 'mark') + px(27, 2, 1, 1, 'mark') + px(27, 4, 1, 1, 'mark'),
  done:
    eyes((x) => px(x - 1, 12, 1, 1, 'eye') + px(x, 11, 2, 1, 'eye') + px(x + 2, 12, 1, 1, 'eye')) +
    px(28, 0, 1, 3, 'spark') + px(27, 1, 3, 1, 'spark') + px(2, 3, 1, 1, 'spark'),
  error: eyes((x) =>
    px(x - 1, 10, 1, 1, 'eye') + px(x + 2, 10, 1, 1, 'eye') + px(x, 11, 2, 2, 'eye') +
    px(x - 1, 13, 1, 1, 'eye') + px(x + 2, 13, 1, 1, 'eye')),
  exited:
    eyes((x) => px(x - 1, 12, 4, 1, 'eye')) +
    px(26, 1, 3, 1, 'mark') + px(27, 2, 1, 1, 'mark') + px(26, 3, 3, 1, 'mark'),
};
FACES.starting = FACES.idle;

// 体・脚・腕。完了のときだけ腕を上げる。
function mascotBody(st) {
  const ay = st === 'done' ? 11 : 16;
  return (
    px(4, 6, 24, 16, 'm-body') +
    px(6, 20, 2, 6, 'm-body leg-a') + px(10, 20, 2, 6, 'm-body leg-b') +
    px(20, 20, 2, 6, 'm-body leg-a') + px(24, 20, 2, 6, 'm-body leg-b') +
    px(0, ay, 5, 4, 'm-body') + px(27, ay, 5, 4, 'm-body')
  );
}

function mascot(status) {
  const st = normStatus(status);
  return (
    `<svg class="mascot st-${st}" viewBox="0 0 32 32" shape-rendering="crispEdges" role="img" aria-label="${STATUS_LABEL[st]}">` +
    `<g class="m-all">${mascotBody(st)}${FACES[st]}</g></svg>`
  );
}

// 3D グラフ用: CSS に依存しない単体 SVG(静止画。状態ごとにキャッシュされる)
const MASCOT_COLORS = {
  starting: '#d77757', idle: '#d77757', working: '#4ea1ff', waiting: '#ffc53d',
  done: '#3fc56b', error: '#ff4d5e', exited: '#6e6862',
};
function mascotImageURL(status) {
  const st = normStatus(status);
  const c = MASCOT_COLORS[st];
  const style = `.m-body{fill:${c}}.eye{fill:#000}.sweat{fill:#7fc4ff}.mark{fill:${c}}.spark{fill:#fff3b0}.dot{fill:#fff}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 32 32" shape-rendering="crispEdges"><style>${style}</style>` +
    `${mascotBody(st)}${FACES[st]}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ---------- タブ(グループと、その中のサブタブ)----------
const GROUPS = {
  home: ['home'],
  apps: ['apps'],
  work: ['term', 'jobs'],
  board: ['board'],
  admin: ['usage', 'audit', 'search', 'tools', 'settings', 'doctor'],
};
const SUB_LABEL = {
  term: 'ターミナル', jobs: 'ジョブ', usage: '使用量', audit: '記録', search: '検索', tools: 'ツール', settings: '設定', doctor: '診断',
};
const TABS = Object.values(GROUPS).flat();
const SECTIONS = ['home', 'apps', 'jobs', 'board', 'usage', 'audit', 'search', 'tools', 'settings', 'doctor']; // term はグリッド(relayout が出し分け)
const groupOf = (tab) => Object.keys(GROUPS).find((g) => GROUPS[g].includes(tab)) || 'home';
const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } };
let curTab = TABS.includes(lsGet('tab')) ? lsGet('tab') : 'home';
const lastSub = (() => { try { return JSON.parse(lsGet('lastSub', '{}')) || {}; } catch (_) { return {}; } })();

function renderSubnav(group) {
  const subs = GROUPS[group];
  const nav = $('#subnav');
  nav.classList.toggle('hidden', subs.length < 2);
  if (subs.length < 2) return;
  nav.innerHTML = subs.map((t) => `<button class="subtab${t === curTab ? ' active' : ''}" data-tab="${t}">${SUB_LABEL[t]}` +
    `<span class="tab-badge" id="sub-badge-${t}"></span></button>`).join('');
  refreshBadges();
}

function setTab(tab) {
  if (!TABS.includes(tab)) tab = 'home';
  curTab = tab;
  const group = groupOf(tab);
  lastSub[group] = tab;
  lsSet('tab', tab);
  lsSet('lastSub', JSON.stringify(lastSub));
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.group === group);
  renderSubnav(group);
  for (const id of SECTIONS) $(`#${id}`).classList.toggle('hidden', tab !== id);
  if (tab === 'audit') window.AuditView.show(); else window.AuditView.hide();
  if (tab === 'usage') window.UsageView.show(); else window.UsageView.hide();
  if (tab === 'tools') window.ToolsView.show();
  $('#layout-wrap').classList.toggle('hidden', tab !== 'term');
  if (tab === 'home') window.GraphView.show(); else window.GraphView.hide();
  if (tab === 'board') window.BoardView.show(); else window.BoardView.hide();
  relayout();
}
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (b) setTab(lastSub[b.dataset.group] || GROUPS[b.dataset.group][0]);
});
$('#subnav').addEventListener('click', (e) => {
  const b = e.target.closest('.subtab');
  if (b) setTab(b.dataset.tab);
});

// バッジ: 作業(入力待ち・承認待ち + 実行中のジョブ)/ ボード(あなた宛ての未読)/ 管理(予算・診断の注意)
const badges = { waiting: 0, jobs: 0, board: 0, admin: 0 };
function setCount(el, n, title) {
  if (!el) return;
  el.textContent = n || '';
  el.classList.toggle('on', n > 0);
  if (title) el.title = title;
}
function refreshBadges() {
  setCount($('#tab-badge'), badges.waiting);
  setCount($('#tab-jobs-badge'), badges.jobs);
  setCount($('#tab-board-badge'), badges.board);
  setCount($('#tab-admin-badge'), badges.admin ? '!' : 0);
  setCount($('#sub-badge-term'), badges.waiting);
  setCount($('#sub-badge-jobs'), badges.jobs);
  setCount($('#sub-badge-settings'), badges.admin ? '!' : 0);
}

function syncGraphSessions() {
  if (!window.GraphView) return;
  window.GraphView.setSessions([...panes.values()].map((p) => ({
    id: p.id, name: p.info.name, cwd: p.info.cwd, status: normStatus(p.info.status), agents: p.info.agents || [],
  })));
}

// ---------- API ----------
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

// ---------- Pane(ターミナル本体) ----------
class Pane {
  constructor(info) {
    this.info = info;
    this.id = info.id;
    this.reconnectTimer = null;
    this.closed = false;
    this.curStatus = null;
    this.stClass = null;

    this.el = document.createElement('section');
    this.el.className = 'pane';
    this.el.innerHTML = `
      <div class="pane-head" draggable="true" title="ドラッグで並べ替え">
        <span class="pane-mascot"></span>
        <span class="pane-title"></span>
        <span class="pane-state"></span>
        <span class="pane-cwd"></span>
        <span class="pane-usage"></span>
        <span class="pane-wt hidden"></span>
        <button class="icon-btn diff" title="作業場所の差分(git diff)">±</button>
        <button class="icon-btn max" title="最大化 / 元に戻す">⤢</button>
        <button class="icon-btn close" title="セッションを終了">✕</button>
      </div>
      <div class="perm-bar hidden"></div>
      <div class="term-wrap"></div>`;
    this.mascotEl = this.el.querySelector('.pane-mascot');
    this.titleEl = this.el.querySelector('.pane-title');
    this.stateEl = this.el.querySelector('.pane-state');
    this.cwdEl = this.el.querySelector('.pane-cwd');
    this.usageEl = this.el.querySelector('.pane-usage');
    this.permEl = this.el.querySelector('.perm-bar');
    this.wtEl = this.el.querySelector('.pane-wt');
    this.wrap = this.el.querySelector('.term-wrap');

    this.term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Noto Sans Mono CJK JP", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
      allowProposedApi: true,
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon());

    // Shift+Enter: 改行(Claude Code の複数行入力用: ESC + CR)
    // Ctrl+C: テキスト選択中ならコピー(Windows の慣習)。未選択なら通常どおり中断(^C)を送る
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Enter' && e.shiftKey) {
        this.send({ type: 'input', data: '\x1b\r' });
        return false;
      }
      const isC = e.key === 'c' || e.key === 'C';
      if (isC && e.ctrlKey && !e.altKey && !e.metaKey && (e.shiftKey || this.term.hasSelection())) {
        const sel = this.term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      return true;
    });

    this.term.onData((data) => this.send({ type: 'input', data }));
    this.term.onResize(({ cols, rows: r }) => this.send({ type: 'resize', cols, rows: r }));

    this.el.addEventListener('mousedown', () => setFocus(this.id));
    this.el.querySelector('.max').addEventListener('click', () => toggleMax(this.id));
    this.el.querySelector('.diff').addEventListener('click', () => window.DiffView.open(this.id));
    this.el.querySelector('.close').addEventListener('click', () => closeSession(this.id));
    this.titleEl.addEventListener('dblclick', () => this.startRename());
    // 見出しをドラッグしてペインを並べ替える(順番はブラウザに保存)
    const head = this.el.querySelector('.pane-head');
    head.addEventListener('dragstart', (e) => {
      if (e.target.closest('button, input')) { e.preventDefault(); return; }
      e.dataTransfer.setData('text/x-galaxy-pane', this.id);
      e.dataTransfer.effectAllowed = 'move';
      this.el.classList.add('dragging');
    });
    head.addEventListener('dragend', () => this.el.classList.remove('dragging'));
    this.el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/x-galaxy-pane')) return;
      e.preventDefault();
      this.el.classList.add('drop-target');
    });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('drop-target'));
    this.el.addEventListener('drop', (e) => {
      this.el.classList.remove('drop-target');
      const from = e.dataTransfer.getData('text/x-galaxy-pane');
      if (!from || from === this.id) return;
      e.preventDefault();
      movePane(from, this.id);
    });

    this.updateHead();
    grid.appendChild(this.el);
    this.term.open(this.wrap);

    this.ro = new ResizeObserver(() => this.refit());
    this.ro.observe(this.wrap);

    this.connect();
  }

  // サーバーからの状態更新を反映
  setInfo(next) {
    const prev = this.info.status;
    this.info = { ...this.info, ...next };
    this.updateHead();
    if (prev !== this.info.status && focusedId !== this.id &&
        ['waiting', 'done', 'error'].includes(this.info.status)) {
      this.el.classList.add('unread');
    }
    if (!this.info.alive) this.markExited(this.info.exitCode);
    else if (this.exitBanner) this.clearExited();
  }

  updateHead() {
    const st = normStatus(this.info.status);
    const app = this.info.appId && window.AppsView ? window.AppsView.get(this.info.appId) : null;
    this.titleEl.textContent = app && app.icon ? `${app.icon}  ${this.info.name}` : this.info.name;
    this.cwdEl.textContent = `${this.info.cwd}  ·  ${this.info.command}`;
    this.cwdEl.title = this.cwdEl.textContent;
    this.stateEl.textContent = STATUS_LABEL[st];
    const wt = this.info.worktree;
    this.wtEl.classList.toggle('hidden', !wt);
    if (wt) {
      this.wtEl.textContent = `⑂ ${wt.branch}${wt.removed ? '(削除済み)' : ''}`;
      this.wtEl.title = `worktree: ${wt.path}\n元のフォルダ: ${wt.origCwd}`;
    }
    const u = this.info.usage;
    this.usageEl.textContent = usageTokens(u) ? fmtCost(u.cost) : '';
    this.usageEl.classList.toggle('warn', !!this.info.costWarn);
    this.usageEl.title = usageTip(u);
    this.el.classList.toggle('dead', !this.info.alive);
    if (this.stClass !== `st-${st}`) {
      if (this.stClass) this.el.classList.remove(this.stClass);
      this.stClass = `st-${st}`;
      this.el.classList.add(this.stClass);
    }
    if (this.curStatus !== st) { // 状態が変わったときだけ描き替える(アニメーションを途切れさせない)
      this.curStatus = st;
      this.mascotEl.innerHTML = mascot(st);
    }
  }

  refit() {
    if (!this.el.offsetParent) return; // 非表示中は何もしない
    try { this.fit.fit(); } catch (_) { /* ignore */ }
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/${this.id}`);
    this.ws = ws;
    ws.onopen = () => {
      // 再接続時はバッファが再送されるので画面をクリアして重複を防ぐ
      this.term.reset();
      this.refit();
      this.send({ type: 'resize', cols: this.term.cols, rows: this.term.rows });
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'output') {
        this.term.write(msg.data);
        if (focusedId !== this.id) this.el.classList.add('unread');
      } else if (msg.type === 'exit') {
        this.info.alive = false;
        this.markExited(msg.exitCode);
      } else if (msg.type === 'restarted') {
        this.info.alive = true;
        this.clearExited();
      }
    };
    ws.onclose = () => {
      if (this.closed || !this.info.alive) return;
      this.reconnectTimer = setTimeout(() => this.connect(), 1500);
    };
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  markExited(code) {
    if (this.exitBanner) return;
    this.info.alive = false;
    this.updateHead();
    const b = document.createElement('div');
    b.className = 'exit-banner';
    const msg = this.info.restored ? 'サーバーの再起動で停止しました' : `プロセスが終了しました (code ${esc(code ?? '?')})`;
    b.innerHTML = `<span>${msg}</span>` +
      (this.info.resumable ? '<button class="btn primary" data-resume="1" title="claude --resume で、前回の会話の続きから起動します">▶ 会話を再開</button>' : '') +
      '<button class="btn" data-resume="0">同じ設定で再起動</button>';
    b.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      btn.disabled = true;
      try {
        const info = await api('POST', `/api/sessions/${this.id}/restart`, { resume: btn.dataset.resume === '1' });
        this.setInfo(info);
        setFocus(this.id);
      } catch (err) {
        UI.toast(err.message, { type: 'error' });
        btn.disabled = false;
      }
    });
    this.wrap.appendChild(b);
    this.exitBanner = b;
  }

  clearExited() {
    if (this.exitBanner) { this.exitBanner.remove(); this.exitBanner = null; }
    this.updateHead();
    // 終了中に WebSocket が切れていたらつなぎ直す
    if (!this.ws || this.ws.readyState > 1) { clearTimeout(this.reconnectTimer); this.connect(); }
  }

  startRename() {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pane-title-input';
    input.value = this.info.name;
    this.titleEl.replaceWith(input);
    input.focus();
    input.select();
    const done = async (commit) => {
      const v = input.value.trim();
      input.replaceWith(this.titleEl);
      if (commit && v && v !== this.info.name) {
        try {
          this.info = { ...this.info, ...(await api('PATCH', `/api/sessions/${this.id}`, { name: v })) };
        } catch (_) { /* ignore */ }
      }
      this.updateHead();
      this.term.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true), { once: true });
  }

  dispose() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.ro.disconnect();
    try { this.ws && this.ws.close(); } catch (_) { /* ignore */ }
    this.term.dispose();
    this.el.remove();
  }
}

// ---------- サイドバーの1行(セッション + サブエージェント) ----------
const AGENT_VISIBLE = 8;

class SideRow {
  constructor(info) {
    this.id = info.id;
    this.info = info;
    this.curStatus = null;
    this.agentSig = '';

    this.el = document.createElement('div');
    this.el.className = 'srow';
    this.el.dataset.id = info.id;
    this.el.innerHTML = `
      <div class="srow-main">
        <span class="mascot-wrap"><span class="m"></span><span class="mbadge"></span></span>
        <div class="srow-text">
          <div class="srow-name"></div>
          <div class="srow-sub"><span class="st-label"></span><span class="sub-time"></span><span class="sub-detail"></span></div>
        </div>
      </div>
      <ul class="agents"></ul>`;
    this.mEl = this.el.querySelector('.m');
    this.badgeEl = this.el.querySelector('.mbadge');
    this.nameEl = this.el.querySelector('.srow-name');
    this.labelEl = this.el.querySelector('.st-label');
    this.timeEl = this.el.querySelector('.sub-time');
    this.detailEl = this.el.querySelector('.sub-detail');
    this.agentsEl = this.el.querySelector('.agents');
    this.update(info);
  }

  update(info) {
    this.info = info;
    const st = normStatus(info.status);
    if (this.curStatus !== st) {
      if (this.curStatus) this.el.classList.remove(`st-${this.curStatus}`);
      this.curStatus = st;
      this.el.classList.add(`st-${st}`);
      this.mEl.innerHTML = mascot(st);
    }
    this.nameEl.textContent = info.name;
    this.labelEl.textContent = STATUS_LABEL[st];
    const u = info.usage;
    this.detailEl.textContent = (info.statusDetail ? ` · ${info.statusDetail}` : '') + (usageTokens(u) ? ` · ${fmtCost(u.cost)}` : '') +
      (info.unread ? ` · ✉ ${info.unread}` : '');
    this.el.title = `${info.name} — ${STATUS_LABEL[st]}${info.statusDetail ? ` (${info.statusDetail})` : ''}\n${info.cwd}` +
      (usageTokens(u) ? `\n${usageTip(u)}` : '');

    const agents = info.agents || [];
    const running = agents.filter((a) => a.status === 'running').length;
    this.badgeEl.textContent = running;
    this.badgeEl.classList.toggle('on', running > 0);

    const sig = JSON.stringify(agents.map((a) => [a.id, a.status, a.type, a.description, a.lastTool]));
    if (sig !== this.agentSig) {
      this.agentSig = sig;
      this.renderAgents(agents);
    }
    this.tick();
  }

  renderAgents(agents) {
    const sorted = [
      ...agents.filter((a) => a.status === 'running').sort((a, b) => a.startedAt - b.startedAt),
      ...agents.filter((a) => a.status !== 'running').sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)),
    ];
    const shown = sorted.slice(0, AGENT_VISIBLE);
    let html = shown.map((a) => {
      const label = a.description || (a.status === 'running' && a.lastTool ? `${a.lastTool} を実行中` : (a.summary || '実行中…'));
      const tip = [a.description, a.lastTool && `最後のツール: ${a.lastTool}`, a.summary].filter(Boolean).join('\n');
      const time = a.status === 'running'
        ? `<span class="atime" data-since="${a.startedAt}"></span>`
        : `<span class="atime">${fmtDur((a.endedAt || a.startedAt) - a.startedAt)}</span>`;
      return `<li class="arow ${esc(a.status)}" title="${esc(tip)}"><span class="aicon"></span>` +
        `<span class="atype">${esc(a.type)}</span>${time}<span class="adesc">${esc(label)}</span></li>`;
    }).join('');
    if (sorted.length > shown.length) html += `<li class="agents-more">ほか ${sorted.length - shown.length} 件</li>`;
    this.agentsEl.innerHTML = html;
    this.agentsEl.style.display = shown.length ? '' : 'none';
  }

  // 経過時間の表示を更新(毎秒)
  tick() {
    const i = this.info;
    const live = i.alive !== false && i.status !== 'exited' && i.statusSince;
    this.timeEl.textContent = live ? ` · ${fmtDur(Date.now() - i.statusSince)}` : '';
    for (const el of this.agentsEl.querySelectorAll('.atime[data-since]')) {
      el.textContent = fmtDur(Date.now() - Number(el.dataset.since));
    }
  }
}

// ---------- 権限確認の受信箱 ----------
/** @type {Map<string, any>} */
const perms = new Map();
const inboxEl = $('#side-inbox');
const inboxToggle = $('#inbox-on');

function permTarget(x) {
  const i = x.input || {};
  if (i.command) return i.command;
  if (i.file_path || i.notebook_path) return i.file_path || i.notebook_path;
  if (i.url) return i.url;
  if (i.pattern) return `${i.pattern}${i.path ? `  (${i.path})` : ''}`;
  return i.path || i.prompt || i.input || '';
}

function permCard(x, { withSession }) {
  const p = panes.get(x.sessionId);
  const isJob = !p && /^j\d+$/.test(x.sessionId);
  const tool = x.mcpServer ? `${x.tool}` : x.tool;
  const rules = (x.rules || []).map((r) => `${r.tool}${r.rule ? `(${r.rule})` : ''} → ${r.destination}`).join('\n');
  const desc = x.input && x.input.description ? `<div class="perm-desc">${esc(x.input.description)}</div>` : '';
  return `<div class="perm" data-perm="${esc(x.id)}">` +
    '<div class="perm-head">' +
      `<b class="perm-tool">${esc(tool)}</b>` +
      (x.agentType ? `<span class="perm-agent">${esc(x.agentType)}</span>` : '') +
      (withSession ? `<span class="perm-sess" data-focus="${esc(x.sessionId)}">${isJob ? '◷ ' : ''}${esc(p ? p.info.name : (x.agentName || x.sessionId))}</span>` : '') +
      `<span class="perm-time" data-exp="${x.expiresAt}"></span>` +
    '</div>' +
    desc +
    `<pre class="perm-body">${esc(permTarget(x))}</pre>` +
    '<div class="perm-acts">' +
      '<button class="btn primary" data-act="allow">許可</button>' +
      (rules ? `<button class="btn" data-act="always" title="次のルールを追加して許可:\n${esc(rules)}">今後も許可</button>` : '') +
      '<button class="btn danger" data-act="deny">拒否</button>' +
      (isJob ? '' : '<button class="btn" data-act="ask" title="この確認をターミナルの通常のダイアログで答えます">ターミナルで</button>') +
    '</div></div>';
}

// 同じ種類の確認(ツール + 提案ルール)をまとめて許可できるようにする
const permKind = (x) => `${x.tool}|${(x.rules && x.rules[0] && x.rules[0].rule) || ''}`;
let permSel = 0; // キーボードで選んでいる確認

function renderInbox() {
  const list = [...perms.values()].sort((a, b) => a.at - b.at);
  permSel = Math.min(permSel, Math.max(0, list.length - 1));
  const groups = new Map();
  for (const x of list) { const k = permKind(x); groups.set(k, (groups.get(k) || []).concat(x)); }
  const batch = [...groups.entries()].filter(([, xs]) => xs.length > 1)
    .map(([k, xs]) => `<button class="btn inbox-batch" data-batch="${esc(k)}" title="同じ種類の確認 ${xs.length} 件を、すべて今回だけ許可します">${esc(xs[0].tool)} をまとめて許可(${xs.length})</button>`).join('');
  inboxEl.innerHTML = list.length
    ? `<div class="inbox-title">承認待ち <b>${list.length}</b><span class="inbox-keys" title="入力欄・ターミナルの外で使えます">A 許可 / D 拒否 / J K 選択</span></div>` +
      (batch ? `<div class="inbox-batches">${batch}</div>` : '') +
      list.map((x, i) => permCard(x, { withSession: true }).replace('class="perm"', `class="perm${i === permSel ? ' sel' : ''}"`)).join('')
    : '';
  inboxEl.classList.toggle('hidden', !list.length);
  for (const p of panes.values()) {
    const mine = list.filter((x) => x.sessionId === p.id);
    p.permEl.innerHTML = mine.map((x) => permCard(x, { withSession: false })).join('');
    p.permEl.classList.toggle('hidden', !mine.length);
  }
  tickInbox();
  renderSummary();
  relayout();
}

function tickInbox() {
  for (const el of document.querySelectorAll('.perm-time[data-exp]')) {
    const left = Number(el.dataset.exp) - Date.now();
    el.textContent = left > 0 ? `あと ${fmtDur(left)}` : '';
  }
}

document.addEventListener('click', async (e) => {
  const sess = e.target.closest('.perm-sess[data-focus]');
  if (sess) {
    if (!panes.has(sess.dataset.focus)) { setTab('jobs'); return; } // ジョブの確認
    if (curTab !== 'term') setTab('term');
    setFocus(sess.dataset.focus);
    return;
  }
  const btn = e.target.closest('.perm [data-act]');
  if (!btn) return;
  const card = btn.closest('.perm');
  const id = card.dataset.perm;
  const act = btn.dataset.act;
  const body = act === 'allow' ? { behavior: 'allow' }
    : act === 'always' ? { behavior: 'allow', always: true }
      : act === 'deny' ? { behavior: 'deny' } : { behavior: 'ask' };
  for (const b of document.querySelectorAll(`.perm[data-perm="${id}"] button`)) b.disabled = true;
  try { await api('POST', `/api/permissions/${id}`, body); } catch (_) { /* もう終わっている */ }
  const x = perms.get(id);
  perms.delete(id);
  renderInbox();
  if (x && act === 'ask') { if (curTab !== 'term') setTab('term'); setFocus(x.sessionId); }
});

// まとめて許可
inboxEl.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-batch]');
  if (!b) return;
  const xs = [...perms.values()].filter((x) => permKind(x) === b.dataset.batch);
  b.disabled = true;
  await Promise.all(xs.map((x) => api('POST', `/api/permissions/${x.id}`, { behavior: 'allow' }).catch(() => {})));
  for (const x of xs) perms.delete(x.id);
  renderInbox();
  UI.toast(`${xs.length} 件を許可しました`);
});

// キーボードで答える(入力欄・ターミナル・ダイアログの外で): A 許可 / D 拒否 / J・K(↑↓)で選ぶ
window.addEventListener('keydown', async (e) => {
  if (!perms.size || e.ctrlKey || e.metaKey || e.altKey || UI.typing(e)) return;
  const list = [...perms.values()].sort((a, b) => a.at - b.at);
  const k = e.key.toLowerCase();
  if (k === 'j' || e.key === 'ArrowDown') { permSel = Math.min(permSel + 1, list.length - 1); renderInbox(); e.preventDefault(); return; }
  if (k === 'k' || e.key === 'ArrowUp') { permSel = Math.max(permSel - 1, 0); renderInbox(); e.preventDefault(); return; }
  if (k !== 'a' && k !== 'd') return;
  const x = list[permSel];
  if (!x) return;
  e.preventDefault();
  try { await api('POST', `/api/permissions/${x.id}`, { behavior: k === 'a' ? 'allow' : 'deny' }); } catch (_) { /* もう終わっている */ }
  perms.delete(x.id);
  renderInbox();
  UI.toast(`${x.tool} を${k === 'a' ? '許可' : '拒否'}しました`);
});

inboxToggle.addEventListener('change', async () => {
  try { await api('PUT', '/api/settings', { permissionInbox: inboxToggle.checked }); } catch (e) { UI.toast(e.message, { type: 'error' }); }
});

async function resyncPermissions() {
  try {
    const list = await api('GET', '/api/permissions');
    perms.clear();
    for (const x of list) perms.set(x.id, x);
    renderInbox();
  } catch (e) { console.error(e); }
}

// ---------- 画面操作 ----------
function setFocus(id) {
  focusedId = id;
  for (const [pid, p] of panes) p.el.classList.toggle('focused', pid === id);
  for (const [rid, r] of rows) r.el.classList.toggle('focused', rid === id);
  const p = panes.get(id);
  if (p) {
    p.el.classList.remove('unread');
    p.term.focus();
  }
}

// ペインの並べ替え(from を to の位置へ)。順番は保存して、次に開いたときも同じ並びにする
function movePane(from, to) {
  const a = panes.get(from);
  const b = panes.get(to);
  if (!a || !b) return;
  const els = [...grid.children];
  if (els.indexOf(a.el) < els.indexOf(b.el)) b.el.after(a.el); else b.el.before(a.el);
  const order = [...grid.querySelectorAll('.pane')].map((el) => [...panes.values()].find((p) => p.el === el)?.id).filter(Boolean);
  lsSet('paneOrder', JSON.stringify(order));
  // Alt+数字の順番も見た目に合わせる
  const sorted = new Map(order.map((id) => [id, panes.get(id)]));
  for (const [id, p] of panes) if (!sorted.has(id)) sorted.set(id, p);
  panes.clear();
  for (const [id, p] of sorted) panes.set(id, p);
  relayout();
}

// 保存してある順番でペインを並べ直す(読み込み時)
function applyPaneOrder() {
  let order = [];
  try { order = JSON.parse(lsGet('paneOrder', '[]')) || []; } catch (_) { order = []; }
  const known = order.filter((id) => panes.has(id));
  if (!known.length) return;
  const rest = [...panes.keys()].filter((id) => !known.includes(id));
  const all = [...known, ...rest];
  for (const id of all) grid.appendChild(panes.get(id).el);
  const entries = all.map((id) => [id, panes.get(id)]);
  panes.clear();
  for (const [id, p] of entries) panes.set(id, p);
}

function toggleMax(id) {
  const p = panes.get(id);
  if (!p) return;
  const willMax = !p.el.classList.contains('maximized');
  for (const q of panes.values()) q.el.classList.remove('maximized');
  if (willMax) p.el.classList.add('maximized');
  grid.classList.toggle('has-max', willMax);
  setFocus(id);
  relayout();
}

function relayout() {
  const n = panes.size;
  const term = curTab === 'term';
  emptyEl.classList.toggle('hidden', !(term && n === 0));
  grid.classList.toggle('hidden', !(term && n > 0));
  const mode = layoutSel.value;
  const cols = mode === 'auto' ? Math.max(1, Math.ceil(Math.sqrt(n))) : Number(mode);
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  // レイアウト変更後に全ターミナルを再フィット
  requestAnimationFrame(() => { for (const p of panes.values()) p.refit(); });
}

let jobCounts = { running: 0, queued: 0 };

// サイドバーのジョブ一覧(実行中・待ちと、10 分以内に終わったもの 3 件まで)
const JOB_IC = { queued: '◷', running: '◐', done: '✓', failed: '✕', canceled: '■' };
function renderSideJobs(jobs) {
  const el = $('#side-jobs');
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
  const recent = jobs.filter((j) => !active.includes(j) && j.endedAt && Date.now() - j.endedAt < 600000)
    .sort((a, b) => b.endedAt - a.endedAt).slice(0, 3);
  const list = [...active, ...recent];
  el.classList.toggle('hidden', !list.length);
  el.innerHTML = list.length ? `<div class="side-sec-title">ジョブ</div>${list.map((j) => `<div class="sjob js-${esc(j.status)}" data-job="${esc(j.id)}" title="${esc(j.prompt.slice(0, 300))}">` +
    `<span class="sjob-ic">${JOB_IC[j.status] || '·'}</span><span class="sjob-name">${esc(j.name)}</span>` +
    `<span class="sjob-meta">${j.status === 'running' ? esc(j.lastTool || '') : j.status === 'queued' ? (j.blockedBy ? '予算で停止' : '待ち') : (j.costUsd ? fmtCost(j.costUsd) : '')}</span></div>`).join('')}` : '';
}
$('#side-jobs').addEventListener('click', (e) => {
  const r = e.target.closest('[data-job]');
  if (r) { setTab('jobs'); window.JobsView.openDetail(r.dataset.job); }
});
sideSummary.addEventListener('click', (e) => {
  if (e.target.closest('.sum-jobs')) setTab('jobs');
  if (e.target.closest('.sum-budget')) setTab('settings');
});


function renderSummary() {
  const infos = [...panes.values()].map((p) => p.info);
  const count = (st) => infos.filter((i) => i.status === st).length;
  const agents = infos.reduce((n, i) => n + (i.agents || []).filter((a) => a.status === 'running').length, 0);
  const waiting = Math.max(count('waiting'), perms.size);
  const cost = infos.reduce((n, i) => n + (i.usage ? i.usage.cost : 0), 0);
  const tokens = infos.reduce((n, i) => n + usageTokens(i.usage), 0);
  sideSummary.innerHTML =
    `<span>セッション <b>${infos.length}</b></span>` +
    `<span>作業中 <b>${count('working')}</b></span>` +
    `<span class="sum-wait">入力待ち <b>${waiting}</b></span>` +
    `<span>サブエージェント <b>${agents}</b></span>` +
    (jobCounts.running + jobCounts.queued ? `<span class="sum-jobs" title="ジョブタブを開く">ジョブ <b>${jobCounts.running}</b>${jobCounts.queued ? ` +待ち ${jobCounts.queued}` : ''}</span>` : '') +
    (tokens ? `<span title="保存されているセッションの合計(概算)">コスト <b>${fmtCost(cost)}</b> · ${fmtTok(tokens)} tok</span>` : '') +
    (() => {
      const b = window.SettingsView && window.SettingsView.budget();
      if (!b || (!b.spent && !b.limit)) return '';
      return `<span class="sum-budget${b.over ? ' over' : b.warn ? ' warn' : ''}" title="今日の使用額(概算)。クリックで設定">今日 <b>${fmtCost(b.spent)}</b>${b.limit ? ` / ${fmtCost(b.limit)}` : ''}</span>`;
    })();
  if (!infos.length && !sideList.querySelector('.srow')) {
    sideList.innerHTML = '<p class="side-empty">セッションなし</p>';
  }
  document.title = perms.size ? `(${perms.size}) 承認待ち — ${TITLE}`
    : waiting ? `(${waiting}) 入力待ち — ${TITLE}` : TITLE;
  badges.waiting = waiting;
  refreshBadges();
  syncGraphSessions();
}

// サーバーからのセッション情報(新規 / 更新)を反映する唯一の入口
function onSession(info) {
  let p = panes.get(info.id);
  if (!p) {
    sideList.querySelector('.side-empty')?.remove();
    p = new Pane(info);
    panes.set(info.id, p);
    const row = new SideRow(info);
    rows.set(info.id, row);
    sideList.appendChild(row.el);
    relayout();
    if (!focusedId) setFocus(info.id);
    if (perms.size) renderInbox();
  } else {
    p.setInfo(info);
    rows.get(info.id)?.update(p.info);
  }
  renderSummary();
}

function removePane(id) {
  const p = panes.get(id);
  if (!p) return;
  p.dispose();
  panes.delete(id);
  rows.get(id)?.el.remove();
  rows.delete(id);
  if (focusedId === id) focusedId = null;
  if (![...panes.values()].some((q) => q.el.classList.contains('maximized'))) grid.classList.remove('has-max');
  relayout();
  const next = [...panes.keys()].pop();
  if (next) setFocus(next);
  renderSummary();
}

async function addSession({ name, cwd, command, appId, worktree, mcpServers, memory }) {
  const info = await api('POST', '/api/sessions', { name, cwd, command, appId, worktree, mcpServers, memory });
  if (!panes.has(info.id)) onSession(info); // SSE より先に応答が届いた場合に備える
  setFocus(info.id);
  return panes.get(info.id);
}

async function closeSession(id, { silent = false } = {}) {
  const p = panes.get(id);
  if (!p) return;
  if (!silent && p.info.alive && !await UI.confirm(`「${p.info.name}」を終了しますか?\n実行中のプロセスは停止されます。`)) return;
  if (!silent && !p.info.alive && p.info.resumable &&
      !await UI.confirm(`「${p.info.name}」を一覧から削除しますか?\nこのアプリからは再開できなくなります(Claude 側の会話履歴は残り、claude --resume で開けます)。`)) return;
  try { await api('DELETE', `/api/sessions/${id}`); } catch (_) { /* ignore */ }
  removePane(id);
}

// ---------- ダイアログ ----------
// prefill: { cwd } (グラフから) / { name, command, appId } (コマンドアプリから)
async function openDialog(prefill = {}) {
  const defaults = await api('GET', '/api/defaults').catch(() => ({ command: 'claude', cwd: '' }));
  const hasCwd = typeof prefill.cwd === 'string' && prefill.cwd;
  const appSel = $('#f-app');
  const cmdApps = window.AppsView ? window.AppsView.commandApps() : [];
  appSel.innerHTML = '<option value="">(コマンドを直接入力)</option>' +
    cmdApps.map((a) => `<option value="${esc(a.id)}">${esc(`${a.icon ? `${a.icon}  ` : ''}${a.name} — ${a.command}`)}</option>`).join('');
  const lastApp = cmdApps.find((a) => a.id === localStorage.getItem('lastApp'));
  const app = prefill.appId ? cmdApps.find((a) => a.id === prefill.appId) : (prefill.command ? null : lastApp);
  appSel.value = app ? app.id : '';
  $('#f-name').value = prefill.name || (hasCwd ? baseName(prefill.cwd) : '');
  $('#f-cwd').value = hasCwd ? prefill.cwd : ((app && app.cwd) || localStorage.getItem('lastCwd') || defaults.cwd || '');
  $('#f-cmd').value = prefill.command || (app && app.command) || localStorage.getItem('lastCmd') || defaults.command || 'claude';
  $('#dlg-error').classList.add('hidden');
  $('#f-worktree').checked = false;
  $('#f-memory').value = '';
  $('#f-mcp').innerHTML = window.ToolsView.pickerHtml(null);
  dlg.showModal();
  (hasCwd || prefill.appId ? $('#f-cwd') : $('#f-name')).focus();
}

$('#f-app').addEventListener('change', (e) => {
  const a = window.AppsView && window.AppsView.get(e.target.value);
  if (!a) return;
  // 名前が空か、別アプリの名前のままなら、選んだアプリの名前に合わせる
  const nm = $('#f-name').value.trim();
  if (!nm || window.AppsView.commandApps().some((x) => x.name === nm)) $('#f-name').value = a.name;
  $('#f-cmd').value = a.command;
  if (a.cwd) $('#f-cwd').value = a.cwd;
});
// コマンドを手で書き換えたら、アプリの選択は外す
$('#f-cmd').addEventListener('input', () => {
  const a = window.AppsView && window.AppsView.get($('#f-app').value);
  if (a && a.command !== $('#f-cmd').value.trim()) $('#f-app').value = '';
});

// コマンドアプリの起動: 作業ディレクトリが決まっていればそのまま、未設定ならダイアログで選ぶ
async function launchCommandApp(a) {
  if (!a.cwd) { openDialog({ name: a.name, command: a.command, appId: a.id }); return; }
  try {
    await addSession({ name: a.name, cwd: a.cwd, command: a.command, appId: a.id });
    setTab('term');
  } catch (e) {
    UI.toast(e.message, { type: 'error' });
  }
}

$('#dlg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cwd = $('#f-cwd').value.trim();
  const command = $('#f-cmd').value.trim();
  const appId = $('#f-app').value || undefined;
  try {
    await addSession({
      name: $('#f-name').value.trim(), cwd, command, appId,
      worktree: $('#f-worktree').checked, mcpServers: window.ToolsView.pickerValue($('#f-mcp')), memory: $('#f-memory').value.trim(),
    });
    localStorage.setItem('lastApp', appId || '');
    localStorage.setItem('lastCwd', cwd);
    localStorage.setItem('lastCmd', command);
    dlg.close();
    setTab('term');
  } catch (err) {
    const el = $('#dlg-error');
    el.textContent = err.message;
    el.classList.remove('hidden');
  }
});
$('#dlg-cancel').addEventListener('click', () => dlg.close());
$('#btn-new').addEventListener('click', () => openDialog());
$('#btn-new-empty').addEventListener('click', () => openDialog());
const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';

layoutSel.value = localStorage.getItem('layout') || 'auto';
layoutSel.addEventListener('change', () => {
  localStorage.setItem('layout', layoutSel.value);
  relayout();
});

// ---------- サイドバー ----------
function applySidebar(collapsed) {
  sidebar.classList.toggle('collapsed', collapsed);
  $('#btn-side').textContent = collapsed ? '»' : '«';
  relayout();
  setTimeout(relayout, 200); // 幅アニメーション後に再フィット
}
$('#btn-side').addEventListener('click', () => {
  const collapsed = !sidebar.classList.contains('collapsed');
  localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
  applySidebar(collapsed);
});
sideList.addEventListener('click', (e) => {
  const row = e.target.closest('.srow');
  if (row) { if (curTab !== 'term') setTab('term'); setFocus(row.dataset.id); }
});

// Alt+1..9 でペインにフォーカス
window.addEventListener('keydown', (e) => {
  if (e.altKey && /^[1-9]$/.test(e.key)) {
    const id = [...panes.keys()][Number(e.key) - 1];
    if (id) { e.preventDefault(); setFocus(id); }
  }
});

window.addEventListener('resize', () => { for (const p of panes.values()) p.refit(); });

setInterval(() => { for (const r of rows.values()) r.tick(); tickInbox(); }, 1000);

// ---------- サーバーからの状態配信(SSE) ----------
async function resync() {
  try {
    const list = await api('GET', '/api/sessions');
    const ids = new Set(list.map((i) => i.id));
    for (const info of list) onSession(info);
    for (const id of [...panes.keys()]) if (!ids.has(id)) removePane(id);
  } catch (e) {
    console.error(e);
  }
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('session', (e) => onSession(JSON.parse(e.data)));
  es.addEventListener('removed', (e) => removePane(JSON.parse(e.data).id));
  es.addEventListener('permission', (e) => {
    const x = JSON.parse(e.data);
    const isNew = !perms.has(x.id);
    perms.set(x.id, x);
    renderInbox();
    if (isNew) {
      UI.notify(`承認待ち: ${x.agentName || x.sessionId}`, `${x.tool}  ${(x.input && (x.input.command || x.input.file_path || x.input.url)) || ''}`.slice(0, 200), {
        tag: `perm-${x.id}`, onClick: () => { if (panes.has(x.sessionId)) { setTab('term'); setFocus(x.sessionId); } else setTab('jobs'); },
      });
    }
  });
  es.addEventListener('budget', (e) => {
    const b = JSON.parse(e.data);
    window.SettingsView.onBudget(b);
    badges.admin = b.over || b.warn ? 1 : 0;
    refreshBadges();
    renderSummary();
    if (b.level) {
      const msg = b.level === 'over'
        ? `今日の予算 $${b.limit.toFixed(2)} に達しました。新しいジョブの起動を止めています`
        : `今日の予算の 8 割に達しました($${b.spent.toFixed(2)} / $${b.limit.toFixed(2)})`;
      UI.toast(msg, { type: b.level === 'over' ? 'error' : 'warn', timeout: 10000, action: { label: '設定', fn: () => setTab('settings') } });
      UI.notify('Claude Galaxy: 予算', msg, { tag: 'budget', onClick: () => setTab('settings') });
    }
  });
  es.addEventListener('permission-removed', (e) => { if (perms.delete(JSON.parse(e.data).id)) renderInbox(); });
  es.addEventListener('settings', (e) => {
    const st = JSON.parse(e.data);
    inboxToggle.checked = !!st.permissionInbox;
    window.JobsView.onSettings(st);
    window.BoardView.onSettings(st);
    window.SettingsView.onSettings(st);
  });
  es.addEventListener('job', (e) => {
    const j = JSON.parse(e.data);
    const prev = window.JobsView.get(j.id);
    window.JobsView.onJob(j);
    if (prev && prev.status === 'running' && (j.status === 'done' || j.status === 'failed')) {
      UI.notify(`ジョブ${j.status === 'done' ? 'が完了' : 'が失敗'}: ${j.name}`, (j.error || j.result || '').slice(0, 200), {
        tag: `job-${j.id}`, onClick: () => { setTab('jobs'); window.JobsView.openDetail(j.id); },
      });
    }
  });
  es.addEventListener('job-removed', (e) => window.JobsView.onJobRemoved(JSON.parse(e.data).id));
  es.addEventListener('automation', (e) => window.JobsView.onAutomation(JSON.parse(e.data)));
  es.addEventListener('automation-removed', (e) => window.JobsView.onAutomationRemoved(JSON.parse(e.data).id));
  es.addEventListener('board', (e) => window.BoardView.onChange(JSON.parse(e.data)));
  es.addEventListener('audit', () => window.AuditView.onEntry());
  es.onopen = () => { resync(); resyncPermissions(); window.JobsView.resync(); window.BoardView.resync(); }; // 切断→再接続時に取りこぼしを補う
}

// ---------- コマンドパレットの候補 ----------
function paletteItems() {
  const items = [];
  const add = (group, icon, label, run, hint = '') => items.push({ group, icon, label, run, hint });
  for (const t of TABS) add('画面', '›', t === 'home' ? 'ホーム' : t === 'apps' ? 'アプリ' : t === 'board' ? 'ボード' : SUB_LABEL[t], () => setTab(t), groupOf(t) === 'admin' ? '管理' : groupOf(t) === 'work' ? '作業' : '');
  add('操作', '＋', '新規セッション', () => openDialog());
  add('操作', '◷', 'ジョブを追加', () => { setTab('jobs'); window.JobsView.newJob(); });
  add('操作', '⚙', 'オートメーションを追加', () => { setTab('jobs'); window.JobsView.newAutomation(); });
  add('操作', '✚', '診断する', () => { setTab('doctor'); window.SettingsView.runDoctor(); });
  add('操作', '⌕', '検索…', () => { setTab('search'); $('#sr-q').focus(); }, 'セッション・ジョブ・メッセージ・共有メモリ');
  add('操作', '◐', `テーマ: ${document.documentElement.dataset.theme === 'dark' ? 'ライトにする' : 'ダークにする'}`,
    () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; UI.setTheme(next); const sel = $('#st-theme'); if (sel) sel.value = next; });
  add('操作', '⚑', `受信箱で承認: ${inboxToggle.checked ? 'オフにする' : 'オンにする'}`, () => { inboxToggle.checked = !inboxToggle.checked; inboxToggle.dispatchEvent(new Event('change')); });
  add('操作', '↓', 'バックアップをダウンロード', () => { location.href = '/api/backup'; });
  add('操作', '?', 'はじめのガイド', () => window.SettingsView.openGuide());
  for (const p of panes.values()) {
    add('セッション', '▣', p.info.name, () => { setTab('term'); setFocus(p.id); }, `${p.id} · ${STATUS_LABEL[normStatus(p.info.status)]} · ${p.info.cwd}`);
  }
  for (const j of window.JobsView.list().sort((a, b) => b.createdAt - a.createdAt).slice(0, 30)) {
    add('ジョブ', '◷', j.name, () => { setTab('jobs'); window.JobsView.openDetail(j.id); }, `${j.id} · ${j.status}`);
  }
  for (const a of (window.AppsView.commandApps ? window.AppsView.commandApps() : [])) add('アプリ', a.icon || '›_', `${a.name} を起動`, () => launchCommandApp(a), a.command);
  return items;
}

// ---------- 起動 ----------
(async function init() {
  applySidebar(localStorage.getItem('sidebarCollapsed') === '1');
  await window.GraphView.init({
    onOpenSession: (id) => { setTab('term'); setFocus(id); },
    onLaunch: (cwd) => openDialog({ cwd }),
    mascotURL: mascotImageURL,
    mascotSVG: mascot,
  });
  await window.AppsView.init({
    showTab: () => setTab('apps'),
    onLaunchCommand: launchCommandApp,
  });
  await window.JobsView.init({
    agentName: (id) => panes.get(id)?.info.name || window.JobsView.get(id)?.name || '',
    onCounts: (c) => { jobCounts = c; badges.jobs = c.running; refreshBadges(); renderSideJobs(c.jobs || []); renderSummary(); },
    onOpenSession: (info) => { onSession(info); setTab('term'); setFocus(info.id); },
  });
  await window.BoardView.init({
    onUnread: (n) => {
      if (n > badges.board) UI.notify('Claude Galaxy: あなた宛てのメッセージ', `未読 ${n} 件`, { tag: 'board', onClick: () => setTab('board') });
      badges.board = n;
      refreshBadges();
    },
  });
  window.AuditView.init();
  await window.ToolsView.init();
  window.DispatchView.init({
    onSession: (info) => { onSession(info); setTab('term'); setFocus(info.id); },
    onJob: (j) => { window.JobsView.onJob(j); setTab('jobs'); },
  });
  await window.SettingsView.init({
    go: (tab) => setTab(tab),
    openRoots: () => { setTab('home'); window.GraphView.openRoots(); },
    newSession: () => openDialog(),
    onDoctor: (d) => { badges.admin = d.ok ? 0 : 1; refreshBadges(); },
    openHit: (kind, id) => {
      if (kind === 'session' && panes.has(id)) { setTab('term'); setFocus(id); }
      else if (kind === 'job') { setTab('jobs'); window.JobsView.openDetail(id); }
      else if (kind === 'memory') { setTab('board'); window.BoardView.searchMemory(id); }
      else setTab('board');
    },
  });
  window.PaletteView.init({ items: paletteItems, dispatch: (text) => window.DispatchView.plan(text) });
  await resync();
  api('GET', '/api/settings').then((st) => {
    inboxToggle.checked = !!st.permissionInbox;
    window.JobsView.onSettings(st);
    window.BoardView.onSettings(st);
    window.SettingsView.onSettings(st);
  }).catch(() => {});
  applyPaneOrder();
  const first = [...panes.keys()][0];
  if (first && !focusedId) setFocus(first);
  setTab(curTab);
  renderSummary();
  connectEvents();
})();
