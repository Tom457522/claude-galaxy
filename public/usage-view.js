'use strict';
// 使用量タブ: Claude Code 全体の使用量(概算)を日別・プロジェクト別・モデル別に見せる

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtUsd = (c) => (c > 0 && c < 0.01 ? '<$0.01' : `$${(c || 0).toFixed(2)}`);
  const fmtTok = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0));
  const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;

  // 色は系統に固定(並び順や件数で塗り替えない)。積み上げの下から順
  const FAMILIES = [
    { key: 'opus', label: 'Opus' },
    { key: 'sonnet', label: 'Sonnet' },
    { key: 'haiku', label: 'Haiku' },
    { key: 'fable', label: 'Fable' },
    { key: 'other', label: 'その他' },
  ];

  const S = { data: null, visible: false, timer: null, resizeObs: null };

  async function load() {
    try {
      const res = await fetch(`/api/usage?days=${encodeURIComponent($('#us-days').value)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      S.data = json;
    } catch (e) {
      S.data = null;
      $('#us-chart').innerHTML = `<p class="jobs-empty">読み込めませんでした: ${esc(e.message)}</p>`;
      return;
    }
    render();
  }

  function render() {
    const d = S.data;
    if (!d) return;
    const t = d.totals;
    const kpi = (label, v, sub = '') => `<div class="us-kpi"><small>${label}</small><b>${fmtUsd(v)}</b>${sub ? `<em>${sub}</em>` : ''}</div>`;
    const active = d.daily.filter((x) => x.cost > 0).length;
    $('#us-kpis').innerHTML =
      kpi('今日', t.today) +
      kpi('直近 7 日', t.week) +
      kpi('今月', t.month) +
      kpi(`${d.days} 日間`, t.range, `${fmtTok(t.tokens)} tok · 使った日の平均 ${fmtUsd(active ? t.range / active : 0)}`);

    const used = FAMILIES.filter((f) => d.daily.some((x) => x.families[f.key]));
    $('#us-legend').innerHTML = used.length > 1 ? used.map((f) => `<span><i class="us-sw us-f-${f.key}"></i>${f.label}</span>`).join('') : '';
    renderChart(used);

    $('#us-daily-table').innerHTML = table(['日付', ...used.map((f) => f.label), '合計', 'トークン'],
      d.daily.slice().reverse().filter((x) => x.cost > 0).map((x) => [esc(x.day), ...used.map((f) => fmtUsd(x.families[f.key] || 0)), `<b>${fmtUsd(x.cost)}</b>`, fmtTok(x.tokens)]));

    const max = (list) => Math.max(...list.map((x) => x.cost), 1e-9);
    const pmax = max(d.projects);
    $('#us-projects').innerHTML = d.projects.length ? `<div class="us-rows">${d.projects.map((p) =>
      `<div class="us-row" title="${esc(p.cwd)}"><span class="us-name">${esc(base(p.cwd))}<small>${p.sessions} セッション · ${fmtTok(p.tokens)} tok</small></span>` +
      `<span class="us-meter"><i style="width:${Math.max(1, (p.cost / pmax) * 100)}%"></i></span><b>${fmtUsd(p.cost)}</b></div>`).join('')}</div>` : empty();

    $('#us-models').innerHTML = d.models.length ? table(['モデル', '入力 / 出力', 'キャッシュ 書込 / 読込', 'コスト'],
      d.models.map((m) => [`<i class="us-sw us-f-${esc(m.family)}"></i>${esc(m.model)}`, `${fmtTok(m.input)} / ${fmtTok(m.output)}`,
        `${fmtTok(m.cacheWrite)} / ${fmtTok(m.cacheRead)}`, `<b>${fmtUsd(m.cost)}</b>`])) : empty();

    const when = (ms) => new Date(ms).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    $('#us-sessions').innerHTML = d.sessions.length ? table(['最終', 'プロジェクト', 'セッション ID', 'トークン', 'コスト'],
      d.sessions.map((s) => [when(s.last), `<span title="${esc(s.cwd)}">${esc(base(s.cwd))}</span>`, `<code>${esc(s.id.slice(0, 8))}</code>`, fmtTok(s.tokens), `<b>${fmtUsd(s.cost)}</b>`])) : empty();

    $('#us-note').textContent = `${d.files} ファイルを集計(${d.dir})。単価は ~/.claude-galaxy/pricing.json で上書きできます。` +
      (t.unpriced ? ` 単価がわからない応答 ${t.unpriced} 件は $0 として数えています。` : '');
  }

  const empty = () => '<p class="jobs-empty">この期間の使用はありません</p>';
  const table = (head, rows) => (rows.length ? `<div class="us-tablewrap"><table class="us-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : empty());

  // 日別の積み上げ棒グラフ(SVG)。棒にマウスを乗せると内訳を出す
  function renderChart(used) {
    const el = $('#us-chart');
    const days = S.data.daily;
    if (!days.some((x) => x.cost > 0)) { el.innerHTML = empty(); return; }
    const W = Math.max(el.clientWidth, 280);
    const H = 220;
    const pad = { l: 48, r: 8, t: 10, b: 24 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const top = niceMax(Math.max(...days.map((x) => x.cost)));
    const y = (v) => pad.t + ih - (v / top) * ih;
    const step = iw / days.length;
    const bw = Math.max(2, Math.min(28, step - 2));
    const ticks = [0, top / 2, top];
    const labelEvery = Math.ceil(days.length / Math.max(2, Math.floor(iw / 48)));

    let svg = `<svg width="${W}" height="${H}" role="img" aria-label="日別のコスト">`;
    for (const v of ticks) {
      svg += `<line class="us-grid-l" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>` +
        `<text class="us-axis" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">$${v >= 10 ? v.toFixed(0) : v.toFixed(v ? 1 : 0)}</text>`;
    }
    days.forEach((x, i) => {
      const cx = pad.l + step * i + step / 2;
      const bx = cx - bw / 2;
      let acc = 0;
      const segs = used.filter((f) => x.families[f.key] > 0);
      segs.forEach((f, si) => {
        const v = x.families[f.key];
        const y0 = y(acc);
        const y1 = y(acc + v);
        acc += v;
        const gap = si > 0 ? 2 : 0; // 段の間に 2px のすき間
        const h = Math.max(0, y0 - y1 - gap);
        if (h <= 0) return;
        const r = si === segs.length - 1 ? Math.min(4, bw / 2, h) : 0; // いちばん上だけ角丸
        svg += `<path class="us-f-${f.key}" d="${barPath(bx, y1, bw, h, r)}"/>`;
      });
      // 目盛りは間引き、最後の日は手前のラベルと重ならないときだけ出す
      if (i % labelEvery === 0 || (i === days.length - 1 && i % labelEvery > labelEvery / 2)) {
        svg += `<text class="us-axis" x="${cx}" y="${H - 6}" text-anchor="middle">${esc(x.day.slice(5).replace('-', '/'))}</text>`;
      }
      svg += `<rect class="us-hit" data-i="${i}" x="${pad.l + step * i}" y="${pad.t}" width="${step}" height="${ih}"/>`;
    });
    svg += '</svg><div class="us-tip hidden"></div>';
    el.innerHTML = svg;
  }

  // 上の角だけ丸めた棒
  function barPath(x, y, w, h, r) {
    if (!r) return `M${x},${y}h${w}v${h}h${-w}Z`;
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
    return 10 * p;
  }

  function onHover(e) {
    const hit = e.target.closest('.us-hit');
    const tip = $('#us-chart .us-tip');
    if (!tip) return;
    for (const r of document.querySelectorAll('#us-chart .us-hit.on')) r.classList.remove('on');
    if (!hit) { tip.classList.add('hidden'); return; }
    hit.classList.add('on');
    const x = S.data.daily[Number(hit.dataset.i)];
    const rows = FAMILIES.filter((f) => x.families[f.key] > 0).reverse()
      .map((f) => `<div><i class="us-sw us-f-${f.key}"></i>${f.label}<b>${fmtUsd(x.families[f.key])}</b></div>`).join('');
    tip.innerHTML = `<strong>${esc(x.day)}</strong>${rows || '<div>使用なし</div>'}<div class="us-tip-total">合計<b>${fmtUsd(x.cost)}</b></div><small>${fmtTok(x.tokens)} tok</small>`;
    tip.classList.remove('hidden');
    const box = $('#us-chart').getBoundingClientRect();
    const hb = hit.getBoundingClientRect();
    const left = hb.left - box.left + hb.width / 2 + 12;
    tip.style.left = `${Math.min(left, box.width - tip.offsetWidth - 4)}px`;
    if (left > box.width - tip.offsetWidth - 4) tip.style.left = `${hb.left - box.left - tip.offsetWidth - 12}px`;
    tip.style.top = '8px';
  }

  $('#us-chart').addEventListener('mousemove', onHover);
  $('#us-chart').addEventListener('mouseleave', () => onHover({ target: document.body }));
  $('#us-days').addEventListener('change', load);
  $('#us-reload').addEventListener('click', load);

  window.UsageView = {
    show() {
      if (S.visible) return;
      S.visible = true;
      load();
      S.timer = setInterval(load, 60000); // 開いている間は 1 分ごとに読み直す
      if (!S.resizeObs && window.ResizeObserver) {
        S.resizeObs = new ResizeObserver(() => { if (S.visible && S.data) renderChart(FAMILIES.filter((f) => S.data.daily.some((x) => x.families[f.key]))); });
        S.resizeObs.observe($('#us-chart'));
      }
    },
    hide() {
      S.visible = false;
      clearInterval(S.timer);
      S.timer = null;
    },
  };
}());
