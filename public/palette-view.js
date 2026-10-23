'use strict';
// コマンドパレット(Ctrl+K / ⌘K): 画面の移動・セッションやジョブへの移動・操作をまとめて探す。
// 当てはまるものがなければ、書いた文章を窓口(やりたいことの振り分け)に回す

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => UI.esc(s);
  const S = { opts: {}, items: [], shown: [], sel: 0 };

  // 文字が順に含まれていれば一致(先頭・連続ほど高い点)
  function score(text, q) {
    const t = text.toLowerCase();
    if (!q) return 1;
    const i = t.indexOf(q);
    if (i >= 0) return 100 - Math.min(i, 50) + (i === 0 ? 50 : 0);
    let pos = 0;
    for (const ch of q) {
      pos = t.indexOf(ch, pos);
      if (pos < 0) return 0;
      pos++;
    }
    return 10;
  }

  function render() {
    const q = $('#pl-input').value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const ranked = S.items
      .map((it) => ({ it, s: words.length ? Math.min(...words.map((w) => score(`${it.label} ${it.hint || ''} ${it.group}`, w))) : 1 }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((x) => x.it);
    const raw = $('#pl-input').value.trim();
    // 文章が書かれていれば、いつでも最後に「窓口で振り分け」を出す(一致がなければ先頭)
    if (raw) {
      const dispatchItem = { group: '窓口', label: `「${raw}」を振り分ける`, hint: 'フォルダ・方法を決めた実行案を作ります', icon: '➤', run: () => S.opts.dispatch(raw) };
      if (ranked.length) ranked.push(dispatchItem); else ranked.unshift(dispatchItem);
    }
    S.shown = ranked;
    S.sel = Math.min(S.sel, Math.max(0, ranked.length - 1));
    let lastGroup = '';
    $('#pl-list').innerHTML = ranked.map((it, i) => {
      const head = it.group !== lastGroup ? `<div class="pl-group">${esc(it.group)}</div>` : '';
      lastGroup = it.group;
      return `${head}<div class="pl-item${i === S.sel ? ' sel' : ''}" data-i="${i}" role="option">` +
        `<span class="pl-ic">${esc(it.icon || '›')}</span><span class="pl-label">${esc(it.label)}</span>` +
        `${it.hint ? `<span class="pl-hint">${esc(it.hint)}</span>` : ''}</div>`;
    }).join('') || '<p class="jobs-empty">文章を書くと、窓口で振り分けます</p>';
    const el = $('#pl-list').querySelector('.pl-item.sel');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function open(text = '') {
    S.items = S.opts.items();
    S.sel = 0;
    $('#pl-input').value = text;
    render();
    if (!$('#dlg-palette').open) $('#dlg-palette').showModal();
    $('#pl-input').focus();
  }

  function run(i) {
    const it = S.shown[i];
    if (!it) return;
    $('#dlg-palette').close();
    setTimeout(() => it.run(), 0);
  }

  function bind() {
    $('#pl-input').addEventListener('input', () => { S.sel = 0; render(); });
    $('#pl-input').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); S.sel = Math.min(S.sel + 1, S.shown.length - 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); S.sel = Math.max(S.sel - 1, 0); render(); }
      else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); run(S.sel); }
    });
    $('#pl-list').addEventListener('click', (e) => {
      const it = e.target.closest('.pl-item');
      if (it) run(Number(it.dataset.i));
    });
    $('#dlg-palette').addEventListener('click', (e) => { if (e.target === $('#dlg-palette')) $('#dlg-palette').close(); });
    $('#btn-palette').addEventListener('click', () => open());
    window.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || (e.key !== 'k' && e.key !== 'K')) return;
      // ターミナル内の Ctrl+K(行の削除)は奪わない
      if (e.target.closest && e.target.closest('.xterm')) return;
      e.preventDefault();
      if ($('#dlg-palette').open) $('#dlg-palette').close(); else open();
    });
  }

  window.PaletteView = { init(opts) { S.opts = opts; bind(); }, open };
})();
