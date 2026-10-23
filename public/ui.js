'use strict';
// 画面共通の部品: トースト通知 / 確認ダイアログ / Markdown の表示 / デスクトップ通知 / テーマ
//   ほかの画面より先に読み込む(window.UI)

(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- トースト(alert の代わり。action で「元に戻す」なども出せる)----------
  let box = null;
  function toast(message, { type = 'info', timeout, action } = {}) {
    if (!box) {
      box = document.createElement('div');
      box.className = 'toasts';
      box.setAttribute('role', 'status');
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = `toast t-${type}`;
    el.innerHTML = `<span class="toast-msg">${esc(message)}</span>` +
      (action ? `<button class="btn toast-act">${esc(action.label)}</button>` : '') +
      '<button class="icon-btn toast-x" title="閉じる">✕</button>';
    const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
    el.querySelector('.toast-x').addEventListener('click', close);
    if (action) el.querySelector('.toast-act').addEventListener('click', () => { close(); action.fn(); });
    box.appendChild(el);
    setTimeout(close, timeout ?? (type === 'error' ? 8000 : action ? 6000 : 4000));
    return close;
  }

  // ---------- 確認ダイアログ(confirm の代わり。Promise<boolean>)----------
  function confirmDialog(message, { ok = 'OK', cancel = 'キャンセル', danger = false, title = '確認' } = {}) {
    return new Promise((resolve) => {
      const d = document.createElement('dialog');
      d.className = 'dlg-confirm';
      d.innerHTML = `<h2>${esc(title)}</h2><p class="confirm-msg">${esc(message)}</p>` +
        `<div class="dlg-actions"><button class="btn" data-v="0">${esc(cancel)}</button>` +
        `<button class="btn ${danger ? 'danger-solid' : 'primary'}" data-v="1">${esc(ok)}</button></div>`;
      document.body.appendChild(d);
      let value = false;
      d.addEventListener('click', (e) => {
        const b = e.target.closest('[data-v]');
        if (b) { value = b.dataset.v === '1'; d.close(); }
      });
      d.addEventListener('close', () => { d.remove(); resolve(value); });
      d.showModal();
      d.querySelector('[data-v="1"]').focus();
    });
  }

  // ---------- Markdown(必要な分だけ。HTML はすべてエスケープしてから整形する)----------
  function inline(t) {
    return t
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  }
  function markdown(src) {
    const lines = esc(String(src || '')).split('\n');
    const out = [];
    let list = null;
    let para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join('<br>'))}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const fence = /^```(\w*)/.exec(l);
      if (fence) {
        flushPara(); flushList();
        const code = [];
        for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
        out.push(`<pre class="md-code"><code>${code.join('\n')}</code></pre>`);
        continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(l);
      if (h) { flushPara(); flushList(); out.push(`<h${h[1].length + 2} class="md-h">${inline(h[2])}</h${h[1].length + 2}>`); continue; }
      const li = /^\s*(?:[-*+]|(\d+)\.)\s+(.*)$/.exec(l);
      if (li) {
        flushPara();
        const tag = li[1] ? 'ol' : 'ul';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push(li[2]);
        continue;
      }
      if (/^\s*(?:---|\*\*\*)\s*$/.test(l)) { flushPara(); flushList(); out.push('<hr>'); continue; }
      if (!l.trim()) { flushPara(); flushList(); continue; }
      flushList();
      para.push(l);
    }
    flushPara(); flushList();
    return `<div class="md">${out.join('')}</div>`;
  }

  // ---------- デスクトップ通知 ----------
  let enabled = true;
  function notify(title, body, { tag, onClick } = {}) {
    if (!enabled || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible' && document.hasFocus()) return; // 画面を見ているときは出さない
    try {
      const n = new Notification(title, { body, tag, icon: '/favicon.ico' });
      n.onclick = () => { window.focus(); n.close(); if (onClick) onClick(); };
    } catch (_) { /* 通知を出せない環境 */ }
  }
  async function requestNotify() {
    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission === 'default') return Notification.requestPermission();
    return Notification.permission;
  }

  // ---------- テーマ(auto / dark / light。画面ごとの設定なのでブラウザに保存)----------
  function applyTheme(mode) {
    const m = mode || (() => { try { return localStorage.getItem('theme') || 'auto'; } catch (_) { return 'auto'; } })();
    const dark = m === 'dark' || (m === 'auto' && !window.matchMedia('(prefers-color-scheme: light)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    return m;
  }
  function setTheme(mode) {
    try { localStorage.setItem('theme', mode); } catch (_) { /* ignore */ }
    applyTheme(mode);
  }
  applyTheme();
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme());

  // 入力欄・ターミナルにフォーカスがあるか(キーボード操作を奪わないため)
  const typing = (e) => {
    const t = e.target;
    return !!(t && t.closest && (t.closest('input, textarea, select, [contenteditable="true"], .xterm') || t.closest('dialog')));
  };

  window.UI = {
    esc, toast, confirm: confirmDialog, markdown, notify, requestNotify, setTheme, applyTheme, typing,
    setNotifyEnabled(v) { enabled = !!v; },
  };
})();
