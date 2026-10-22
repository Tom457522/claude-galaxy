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

function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${String(s % 60).padStart(2, '0')}秒`;
  return `${Math.floor(m / 60)}時間${m % 60}分`;
}

// ---------- オリジナルキャラクター「ぽこ」 ----------
// 状態ごとに表情と色(CSS の .st-* )が変わる。アニメーションも状態ごとに別。
const FACES = {
  idle:
    '<path class="ln" d="M14 31 Q17 34 20 31"/><path class="ln" d="M28 31 Q31 34 34 31"/>' +
    '<path class="ln" d="M21 38 Q24 40.5 27 38"/>',
  working:
    '<circle class="eye" cx="17" cy="31" r="3"/><circle class="eye" cx="31" cy="31" r="3"/>' +
    '<circle class="glint" cx="18" cy="30" r="1"/><circle class="glint" cx="32" cy="30" r="1"/>' +
    '<path class="ln" d="M12.5 25.5 L20 27.5"/><path class="ln" d="M35.5 25.5 L28 27.5"/>' +
    '<path class="ln" d="M21.5 39 L26.5 39"/>' +
    '<path class="sweat" d="M39 17 Q41.5 21 39 23 Q36.5 21 39 17Z"/>',
  waiting:
    '<circle class="eye" cx="17" cy="31" r="3.6"/><circle class="eye" cx="31" cy="31" r="3.6"/>' +
    '<circle class="glint" cx="18" cy="29.5" r="1.2"/><circle class="glint" cx="32" cy="29.5" r="1.2"/>' +
    '<ellipse class="mouth" cx="24" cy="39.5" rx="2.2" ry="2.8"/>' +
    '<text class="mark" x="37" y="13">?</text>',
  done:
    '<path class="ln" d="M14 33 Q17 28 20 33"/><path class="ln" d="M28 33 Q31 28 34 33"/>' +
    '<path class="mouth" d="M19 37.5 Q24 46 29 37.5Z"/>' +
    '<circle class="cheek" cx="12.5" cy="37" r="2.4"/><circle class="cheek" cx="35.5" cy="37" r="2.4"/>' +
    '<path class="spark" d="M40 8 L41.2 11.2 L44.4 12.4 L41.2 13.6 L40 16.8 L38.8 13.6 L35.6 12.4 L38.8 11.2Z"/>',
  error:
    '<path class="ln" d="M14.5 28.5 L19.5 33.5 M19.5 28.5 L14.5 33.5"/>' +
    '<path class="ln" d="M28.5 28.5 L33.5 33.5 M33.5 28.5 L28.5 33.5"/>' +
    '<path class="ln" d="M19 40.5 Q21.5 37.5 24 40.5 T29 40.5"/>',
  exited:
    '<path class="ln" d="M14 32 L20 32"/><path class="ln" d="M28 32 L34 32"/>' +
    '<path class="ln" d="M22 39 L26 39"/><text class="mark" x="36" y="14">z</text>',
};
FACES.starting = FACES.idle;

function mascot(status) {
  const st = normStatus(status);
  return (
    `<svg class="mascot st-${st}" viewBox="0 0 48 52" role="img" aria-label="${STATUS_LABEL[st]}">` +
    '<g class="m-all">' +
    '<path class="m-body" d="M24 3 C28 11 41 17 41 31 C41 41 33 48 24 48 C15 48 7 41 7 31 C7 17 20 11 24 3 Z"/>' +
    '<ellipse class="shine" cx="16.5" cy="27" rx="2.6" ry="5" transform="rotate(20 16.5 27)"/>' +
    FACES[st] +
    '</g></svg>'
  );
}

// 3D グラフ用: CSS に依存しない単体 SVG(静止画。状態ごとにキャッシュされる)
const MASCOT_COLORS = {
  starting: '#d97757', idle: '#d97757', working: '#f08a5d', waiting: '#e5b567',
  done: '#8fbf7f', error: '#e5484d', exited: '#5b534c',
};
function mascotImageURL(status) {
  const st = normStatus(status);
  const c = MASCOT_COLORS[st];
  const style = `.m-body{fill:${c};stroke:rgba(0,0,0,.35);stroke-width:1}.shine{fill:#fff;opacity:.22}` +
    '.ln{fill:none;stroke:#1a0f0a;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
    '.eye,.mouth{fill:#1a0f0a}.glint{fill:#fff}.cheek{fill:#ff9d8a;opacity:.6}.sweat{fill:#7fc4ff}' +
    `.mark{fill:${c};font:700 14px monospace}.spark{fill:#fff3b0}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="208" viewBox="0 0 48 52"><style>${style}</style>` +
    '<path class="m-body" d="M24 3 C28 11 41 17 41 31 C41 41 33 48 24 48 C15 48 7 41 7 31 C7 17 20 11 24 3 Z"/>' +
    '<ellipse class="shine" cx="16.5" cy="27" rx="2.6" ry="5" transform="rotate(20 16.5 27)"/>' +
    `${FACES[st]}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ---------- タブ ----------
const TABS = ['home', 'apps', 'term'];
let curTab = TABS.includes(localStorage.getItem('tab')) ? localStorage.getItem('tab') : 'home';

function setTab(tab) {
  curTab = tab;
  try { localStorage.setItem('tab', tab); } catch (_) { /* ignore */ }
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
  $('#home').classList.toggle('hidden', tab !== 'home');
  $('#apps').classList.toggle('hidden', tab !== 'apps');
  $('#layout-wrap').classList.toggle('hidden', tab !== 'term');
  if (tab === 'home') window.GraphView.show(); else window.GraphView.hide();
  relayout();
}
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (b) setTab(b.dataset.tab);
});

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
      <div class="pane-head">
        <span class="pane-mascot"></span>
        <span class="pane-title"></span>
        <span class="pane-state"></span>
        <span class="pane-cwd"></span>
        <button class="icon-btn max" title="最大化 / 元に戻す">⤢</button>
        <button class="icon-btn close" title="セッションを終了">✕</button>
      </div>
      <div class="term-wrap"></div>`;
    this.mascotEl = this.el.querySelector('.pane-mascot');
    this.titleEl = this.el.querySelector('.pane-title');
    this.stateEl = this.el.querySelector('.pane-state');
    this.cwdEl = this.el.querySelector('.pane-cwd');
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
    this.el.querySelector('.close').addEventListener('click', () => closeSession(this.id));
    this.titleEl.addEventListener('dblclick', () => this.startRename());

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
  }

  updateHead() {
    const st = normStatus(this.info.status);
    const app = this.info.appId && window.AppsView ? window.AppsView.get(this.info.appId) : null;
    this.titleEl.textContent = app && app.icon ? `${app.icon}  ${this.info.name}` : this.info.name;
    this.cwdEl.textContent = `${this.info.cwd}  ·  ${this.info.command}`;
    this.cwdEl.title = this.cwdEl.textContent;
    this.stateEl.textContent = STATUS_LABEL[st];
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
    b.innerHTML = `<span>プロセスが終了しました (code ${esc(code ?? '?')})</span><button class="btn">同じ設定で再起動</button>`;
    b.querySelector('button').addEventListener('click', async () => {
      const { name, cwd, command, appId } = this.info;
      await closeSession(this.id, { silent: true });
      try { await addSession({ name, cwd, command, appId }); } catch (e) { alert(e.message); }
    });
    this.wrap.appendChild(b);
    this.exitBanner = b;
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
    this.detailEl.textContent = info.statusDetail ? ` · ${info.statusDetail}` : '';
    this.el.title = `${info.name} — ${STATUS_LABEL[st]}${info.statusDetail ? ` (${info.statusDetail})` : ''}\n${info.cwd}`;

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

function renderSummary() {
  const infos = [...panes.values()].map((p) => p.info);
  const count = (st) => infos.filter((i) => i.status === st).length;
  const agents = infos.reduce((n, i) => n + (i.agents || []).filter((a) => a.status === 'running').length, 0);
  const waiting = count('waiting');
  sideSummary.innerHTML =
    `<span>セッション <b>${infos.length}</b></span>` +
    `<span>作業中 <b>${count('working')}</b></span>` +
    `<span class="sum-wait">入力待ち <b>${waiting}</b></span>` +
    `<span>サブエージェント <b>${agents}</b></span>`;
  if (!infos.length && !sideList.querySelector('.srow')) {
    sideList.innerHTML = '<p class="side-empty">セッションなし</p>';
  }
  document.title = waiting ? `(${waiting}) 入力待ち — ${TITLE}` : TITLE;
  const badge = $('#tab-badge');
  badge.textContent = waiting || '';
  badge.classList.toggle('on', waiting > 0);
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

async function addSession({ name, cwd, command, appId }) {
  const info = await api('POST', '/api/sessions', { name, cwd, command, appId });
  if (!panes.has(info.id)) onSession(info); // SSE より先に応答が届いた場合に備える
  setFocus(info.id);
  return panes.get(info.id);
}

async function closeSession(id, { silent = false } = {}) {
  const p = panes.get(id);
  if (!p) return;
  if (!silent && p.info.alive && !confirm(`「${p.info.name}」を終了しますか?\n実行中のプロセスは停止されます。`)) return;
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
    alert(e.message);
  }
}

$('#dlg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cwd = $('#f-cwd').value.trim();
  const command = $('#f-cmd').value.trim();
  const appId = $('#f-app').value || undefined;
  try {
    await addSession({ name: $('#f-name').value.trim(), cwd, command, appId });
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

setInterval(() => { for (const r of rows.values()) r.tick(); }, 1000);

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
  es.onopen = () => { resync(); }; // 切断→再接続時に取りこぼしを補う
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
  await resync();
  const first = [...panes.keys()][0];
  if (first && !focusedId) setFocus(first);
  setTab(curTab);
  renderSummary();
  connectEvents();
})();
