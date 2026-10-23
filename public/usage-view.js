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

  const S = { data: null, cloud: null, visible: false, timer: null, resizeObs: null };
  // プロジェクト名: クラウドは「☁ 持ち主/リポジトリ」をそのまま、ローカルはフォルダ名
  const projName = (x) => (x.cloud ? x.cwd : base(x.cwd));

  async function load(refresh = false) {
    try {
      const q = `days=${encodeURIComponent($('#us-days').value)}&source=${encodeURIComponent($('#us-source').value)}${refresh ? '&refresh=1' : ''}`;
      const [res, cl] = await Promise.all([fetch(`/api/usage?${q}`), fetch('/api/cloud-sessions')]);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      S.data = json;
      S.cloud = cl.ok ? await cl.json() : null;
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
      kpi(`${d.days} 日間`, t.range, `${fmtTok(t.tokens)} tok · 使った日の平均 ${fmtUsd(active ? t.range / active : 0)}`) +
      (d.source === 'all' ? kpi(`うちクラウド(${d.days} 日間)`, t.cloud, `今日 ${fmtUsd(t.cloudToday)} · ${t.range ? Math.round((t.cloud / t.range) * 100) : 0}%`) : '');

    const used = FAMILIES.filter((f) => d.daily.some((x) => x.families[f.key]));
    $('#us-legend').innerHTML = used.length > 1 ? used.map((f) => `<span><i class="us-sw us-f-${f.key}"></i>${f.label}</span>`).join('') : '';
    renderChart(used);

    $('#us-daily-table').innerHTML = table(['日付', ...used.map((f) => f.label), '合計', 'トークン'],
      d.daily.slice().reverse().filter((x) => x.cost > 0).map((x) => [esc(x.day), ...used.map((f) => fmtUsd(x.families[f.key] || 0)), `<b>${fmtUsd(x.cost)}</b>`, fmtTok(x.tokens)]));

    const max = (list) => Math.max(...list.map((x) => x.cost), 1e-9);
    const pmax = max(d.projects);
    $('#us-projects').innerHTML = d.projects.length ? `<div class="us-rows">${d.projects.map((p) =>
      `<div class="us-row" title="${esc(p.cwd)}"><span class="us-name">${esc(projName(p))}<small>${p.sessions} セッション · ${fmtTok(p.tokens)} tok</small></span>` +
      `<span class="us-meter"><i style="width:${Math.max(1, (p.cost / pmax) * 100)}%"></i></span><b>${fmtUsd(p.cost)}</b></div>`).join('')}</div>` : empty();

    $('#us-models').innerHTML = d.models.length ? table(['モデル', '入力 / 出力', 'キャッシュ 書込 / 読込', 'コスト'],
      d.models.map((m) => [`<i class="us-sw us-f-${esc(m.family)}"></i>${esc(m.model)}`, `${fmtTok(m.input)} / ${fmtTok(m.output)}`,
        `${fmtTok(m.cacheWrite)} / ${fmtTok(m.cacheRead)}`, `<b>${fmtUsd(m.cost)}</b>`])) : empty();

    const when = (ms) => new Date(ms).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const cloudById = new Map(((S.cloud && S.cloud.sessions) || []).map((c) => [c.id, c]));
    $('#us-sessions').innerHTML = d.sessions.length ? table(['最終', 'プロジェクト', 'セッション', 'トークン', 'コスト'],
      d.sessions.map((s) => {
        const c = s.cloud && cloudById.get(s.id);
        const name = c ? `<a href="${esc(c.url)}" target="_blank" rel="noopener" title="${esc(s.id)}">☁ ${esc(c.title || s.id)}</a>` : `<code>${esc(s.id.slice(0, 8))}</code>`;
        return [when(s.last), `<span title="${esc(s.cwd)}">${esc(projName(s))}</span>`, name, fmtTok(s.tokens), `<b>${fmtUsd(s.cost)}</b>`];
      })) : empty();
    renderCloud();

    $('#us-note').textContent = `${d.files} ファイル + クラウドセッション ${(d.cloud && d.cloud.count) || 0} 件を集計(${d.dir})。単価は ~/.claude-galaxy/pricing.json で上書きできます。` +
      (t.unpriced ? ` 単価がわからない応答 ${t.unpriced} 件は $0 として数えています。` : '');
  }

  // クラウドセッションの一覧。額は events から数えた API 換算、読み終える前は Claude Code が数えた累計を出す
  function renderCloud() {
    const c = S.cloud;
    const st = $('#cl-state');
    if (!c) { st.textContent = ''; $('#cl-list').innerHTML = empty(); return; }
    st.textContent = [
      c.error || '',
      c.fetchedAt ? `${new Date(c.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} に取得 · ${c.count} 件` : '',
      c.pending ? `${c.pending} 件の記録を取り込み中` : '',
    ].filter(Boolean).join(' · ');
    st.className = c.error ? 'warn' : '';
    const costs = new Map((S.data && S.data.source !== 'local' ? S.data.sessions : []).map((s) => [s.id, s]));
    const when = (ms) => (ms ? new Date(ms).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
    const list = c.sessions.filter((s) => !s.archived);
    $('#cl-list').innerHTML = list.length ? table(['状態', 'タイトル', 'リポジトリ / ブランチ', 'モデル', '最終更新', 'トークン', '累計(Claude Code の計算)'],
      list.map((s) => {
        const tok = s.meta.input + s.meta.output + s.meta.cacheWrite + s.meta.cacheRead;
        const running = s.status && s.status !== 'idle';
        const inRange = costs.get(s.id);
        return [
          `<span class="cl-st${running ? ' on' : ''}">${running ? '● ' : '○ '}${esc(s.status || '—')}</span>`,
          `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.id)}</a>${s.origin === 'ios' || s.origin === 'android' ? ' <small>📱</small>' : ''}`,
          s.repo ? `${esc(s.repo)}${s.branch ? `<br><small><code>${esc(s.branch)}</code></small>` : ''}` : '—',
          esc(s.model),
          when(Date.parse(s.updated)),
          fmtTok(tok),
          `<b>${fmtUsd(s.meta.cost)}</b>${inRange ? `<br><small>期間内 ${fmtUsd(inRange.cost)}</small>` : ''}${s.synced ? '' : '<br><small>取り込み中</small>'}`,
        ];
      })) : '<p class="jobs-empty">クラウドセッションはありません</p>';
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
    tip.innerHTML = `<strong>${esc(x.day)}</strong>${rows || '<div>使用なし</div>'}<div class="us-tip-total">合計<b>${fmtUsd(x.cost)}</b></div>${x.cloud > 0 && S.data.source === 'all' ? `<div>うちクラウド<b>${fmtUsd(x.cloud)}</b></div>` : ''}<small>${fmtTok(x.tokens)} tok</small>`;
    tip.classList.remove('hidden');
    const box = $('#us-chart').getBoundingClientRect();
    const hb = hit.getBoundingClientRect();
    const left = hb.left - box.left + hb.width / 2 + 12;
    tip.style.left = `${Math.min(left, box.width - tip.offsetWidth - 4)}px`;
    if (left > box.width - tip.offsetWidth - 4) tip.style.left = `${hb.left - box.left - tip.offsetWidth - 12}px`;
    tip.style.top = '8px';
  }

  // ---------- プランと制限(Anthropic から読んだ実際の利用率)----------
  const P = { data: null };
  const SERIES = { session: 'pl-session', weekly: 'pl-weekly' }; // 色は制限の種類に固定
  const hm = (ms) => {
    const m = Math.max(0, Math.round(ms / 60000));
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    return d ? `${d}日 ${h}時間` : h ? `${h}時間 ${m % 60}分` : `${m % 60}分`;
  };
  const clock = (ms) => new Date(ms).toLocaleString([], { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });

  async function loadPlan(refresh = false) {
    try {
      const res = await fetch(`/api/plan${refresh ? '?refresh=1' : ''}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      P.data = json;
    } catch (e) {
      P.data = { ok: false, error: `読み込めませんでした: ${e.message}`, limits: [], history: [], windows: {} };
    }
    renderPlan();
  }

  function renderPlan() {
    const p = P.data;
    if (!p) return;
    const err = $('#pl-error');
    err.textContent = p.error || '';
    err.classList.toggle('hidden', !p.error);
    $('#pl-plan').textContent = p.plan ? `${p.plan.name}${p.plan.monthlyUsd ? ` · 月額 $${p.plan.monthlyUsd}` : ''}` : '';
    $('#pl-fetched').textContent = p.fetchedAt ? `${new Date(p.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 時点${p.stale ? '(古い値)' : ''}` : '';

    const now = Date.now();
    $('#pl-meters').innerHTML = p.limits.length ? p.limits.map((l) => {
      const st = l.reason ? 'over' : l.percent >= l.threshold - 10 ? 'warn' : '';
      const win = p.windows && p.windows[l.group];
      // その期間に使った API 換算額から「100% ≈ いくら分か」の目安を出す(週間は Claude Code の割合で按分)
      const cc = l.group === 'weekly' ? (p.breakdown || []).find((b) => b.key === 'claude_code') : null;
      const share = cc ? cc.percent / 100 : 1;
      const full = win && l.percent >= 3 && share > 0 ? win.cost / ((l.percent * share) / 100) : 0;
      const sub = [
        l.resetsAt ? `リセットまで ${hm(l.resetsAt - now)}(${clock(l.resetsAt)})` : '',
        // 見込みが 100% を超えるなら、上限に届く時刻のほうがわかりやすい
        l.projected === null || l.projected === undefined ? ''
          : l.projected >= 100 && l.percent < 100 ? `このペースだと ${clock(l.startsAt + ((now - l.startsAt) * 100) / l.percent)} ごろ上限に到達`
            : `このペースだとリセット時 約 ${Math.round(l.projected)}%`,
        win ? `この期間の API 換算 ${fmtUsd(win.cost)}${full ? ` · 100% ≈ ${fmtUsd(full)} 分` : ''}` : '',
      ].filter(Boolean);
      return `<div class="pl-meter ${SERIES[l.group] || ''} ${st}">
        <div class="pl-meter-top"><span><i class="us-sw ${SERIES[l.group] || ''}"></i>${esc(l.label)}</span>` +
        `<b>${Math.round(l.percent)}<small>%</small></b>${st ? `<em class="pl-badge ${st}">${st === 'over' ? '■ ジョブ停止中' : '▲ もうすぐ上限'}</em>` : ''}</div>
        <div class="pl-bar" role="img" aria-label="${esc(l.label)} ${Math.round(l.percent)}%">` +
        `<i class="pl-fill" style="width:${Math.min(100, l.percent)}%"></i>` +
        (l.elapsed !== null && l.elapsed !== undefined ? `<span class="pl-mark pl-now" style="left:${l.elapsed * 100}%" title="経過時間 ${Math.round(l.elapsed * 100)}%"></span>` : '') +
        (l.threshold < 100 ? `<span class="pl-mark pl-thr" style="left:${l.threshold}%" title="ジョブを止める ${l.threshold}%"></span>` : '') +
        `</div>
        <div class="pl-scale"><span>0</span>${l.elapsed !== null && l.elapsed !== undefined ? `<span style="left:${l.elapsed * 100}%">経過 ${Math.round(l.elapsed * 100)}%</span>` : ''}<span class="r">100%</span></div>
        <small class="pl-meter-sub">${sub.map(esc).join('<br>')}</small>
      </div>`;
    }).join('') : (p.error ? '' : '<p class="jobs-empty">制限の情報がありません</p>');

    const groups = [...new Set(p.limits.map((l) => l.group))];
    $('#pl-legend').innerHTML = [
      ...groups.map((g) => `<span><i class="us-sw ${SERIES[g] || ''}"></i>${g === 'session' ? '5 時間' : '週間'}</span>`),
      '<span><i class="pl-sw-dash"></i>均等に使うペース</span>',
    ].join('');
    renderPlanChart();
    renderPlanBars();

    const bill = [];
    if (p.plan && p.plan.monthlyUsd && p.month) {
      const ratio = p.month.cost / p.plan.monthlyUsd;
      bill.push(`<div class="pl-bill"><small>今月の API 換算(暦月)</small><b>${fmtUsd(p.month.cost)}</b><em>月額 $${p.plan.monthlyUsd}${p.plan.monthlyAuto ? '' : '(設定)'} の ${ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1)} 倍分</em></div>`);
    }
    if (p.extra) {
      bill.push(`<div class="pl-bill"><small>追加利用(従量課金)</small><b>${fmtUsd(p.extra.usedUsd)}</b><em>${p.extra.limitUsd ? `月の上限 ${fmtUsd(p.extra.limitUsd)} の ${Math.round(p.extra.percent)}%` : '上限なし'}</em></div>`);
    } else if (p.ok) {
      bill.push('<div class="pl-bill"><small>追加利用(従量課金)</small><b>オフ</b><em>上限に達したら止まり、追加の請求はありません</em></div>');
    }
    if (p.breakdown && p.breakdown.some((b) => b.percent > 0)) {
      bill.push(`<div class="pl-bill"><small>今週の内訳</small><em class="pl-bd">${p.breakdown.filter((b) => b.percent > 0).map((b) => `${esc(b.name)} <b>${b.percent}%</b>`).join(' · ')}</em></div>`);
    }
    $('#pl-billing').innerHTML = bill.join('');

    const s = (g) => p.limits.find((l) => l.group === g);
    const thr = (g) => (s(g) ? `${s(g).threshold}%` : '—');
    $('#pl-guard').innerHTML = `ジョブを止める利用率: 5 時間 ${thr('session')} · 週間 ${thr('weekly')} · 週のペースガード ${p.paceGuard ? 'オン' : 'オフ'}(<a href="#" id="pl-to-settings">設定で変更</a>)。100% ≈ の額は、その期間の API 換算額から逆算した目安です。`;
  }

  // 今週の期間(週の制限の開始〜リセット)を x 軸にした折れ線。5 時間と週間の 2 本 + 均等ペースの斜線 + しきい値
  function planDomain() {
    const p = P.data;
    const w = p.limits.find((l) => l.group === 'weekly' && l.startsAt);
    const now = Date.now();
    return w ? [w.startsAt, w.resetsAt] : [now - 7 * 24 * 3600e3, now];
  }

  function renderPlanChart() {
    const el = $('#pl-chart');
    const p = P.data;
    const [x0, x1] = planDomain();
    const pts = (p.history || []).filter((h) => h.t >= x0 && h.t <= x1);
    if (!p.limits.length) { el.innerHTML = ''; return; }
    const W = Math.max(el.clientWidth, 280);
    const H = 200;
    const pad = { l: 40, r: 10, t: 10, b: 24 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const x = (t) => pad.l + ((t - x0) / (x1 - x0)) * iw;
    const y = (v) => pad.t + ih - (Math.min(100, v) / 100) * ih;
    let svg = `<svg width="${W}" height="${H}" role="img" aria-label="利用率の推移">`;
    for (const v of [0, 50, 100]) {
      svg += `<line class="us-grid-l" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text class="us-axis" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`;
    }
    svg += dayTicks(x0, x1, x, H);
    svg += `<line class="pl-pace" x1="${x(x0)}" y1="${y(0)}" x2="${x(x1)}" y2="${y(100)}"/>`;
    for (const l of p.limits) {
      if (l.threshold < 100 && (l.group === 'weekly' || !p.limits.some((o) => o !== l && o.group === l.group && o.threshold === l.threshold))) {
        svg += `<line class="pl-thr-l ${SERIES[l.group]}" x1="${pad.l}" x2="${W - pad.r}" y1="${y(l.threshold)}" y2="${y(l.threshold)}"/>`;
      }
    }
    const now = Date.now();
    if (now > x0 && now < x1) svg += `<line class="pl-now-l" x1="${x(now)}" x2="${x(now)}" y1="${pad.t}" y2="${pad.t + ih}"/><text class="us-axis" x="${x(now)}" y="${pad.t + 8}" text-anchor="${x(now) > W - 40 ? 'end' : 'middle'}">今</text>`;
    // 線は制限の種類ごと(同じ種類に複数の制限があるときは最初のもの = 全モデル)
    for (const g of ['weekly', 'session']) {
      const l = p.limits.find((o) => o.group === g);
      if (!l) continue;
      const vals = pts.filter((h) => Number.isFinite(h.v[l.kind])).map((h) => [h.t, h.v[l.kind]]);
      if (!vals.length) continue;
      svg += `<path class="pl-line ${SERIES[g]}" d="${vals.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('')}"/>`;
      const [lt, lv] = vals[vals.length - 1];
      svg += `<circle class="pl-dot ${SERIES[g]}" cx="${x(lt)}" cy="${y(lv)}" r="4"/>`;
    }
    svg += `<rect class="pl-hit" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}"/><line class="pl-cross hidden" y1="${pad.t}" y2="${pad.t + ih}"/></svg><div class="us-tip hidden"></div>`;
    if (!pts.length) svg += '<p class="pl-empty">推移は Galaxy を動かしている間に 5 分ごとに記録していきます</p>';
    el.innerHTML = svg;
    el.dataset.geom = JSON.stringify({ x0, x1, l: pad.l, iw });
  }

  function dayTicks(x0, x1, x, H) {
    let out = '';
    const d = new Date(x0);
    d.setHours(24, 0, 0, 0);
    for (let t = d.getTime(); t < x1; t += 24 * 3600e3) {
      out += `<line class="us-grid-l pl-vgrid" x1="${x(t)}" x2="${x(t)}" y1="10" y2="${H - 24}"/>` +
        `<text class="us-axis" x="${x(t)}" y="${H - 6}" text-anchor="middle">${new Date(t).toLocaleDateString([], { month: 'numeric', day: 'numeric', weekday: 'short' })}</text>`;
    }
    return out;
  }

  // 同じ x 軸で、1 時間ごとの API 換算コスト(トランスクリプトから)
  function renderPlanBars() {
    const el = $('#pl-bars');
    const w = P.data.windows && P.data.windows.weekly;
    if (!w || !w.buckets.some((b) => b.cost > 0)) { el.innerHTML = '<p class="pl-empty">この期間の使用はありません</p>'; return; }
    const [x0, x1] = planDomain();
    const W = Math.max(el.clientWidth, 280);
    const H = 70;
    const pad = { l: 40, r: 10, t: 6, b: 4 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const x = (t) => pad.l + ((t - x0) / (x1 - x0)) * iw;
    const top = niceMax(Math.max(...w.buckets.map((b) => b.cost)));
    const bw = Math.max(1, x(x0 + w.bucketMs) - x(x0) - 1);
    let svg = `<svg width="${W}" height="${H}" role="img" aria-label="1 時間ごとの API 換算コスト">` +
      `<line class="us-grid-l" x1="${pad.l}" x2="${W - pad.r}" y1="${pad.t + ih}" y2="${pad.t + ih}"/>` +
      `<text class="us-axis" x="${pad.l - 6}" y="${pad.t + 8}" text-anchor="end">$${top >= 10 ? top.toFixed(0) : top.toFixed(1)}</text>`;
    for (const b of w.buckets) {
      if (!(b.cost > 0)) continue;
      const h = Math.max(1, (b.cost / top) * ih);
      svg += `<path class="pl-bar-c" d="${barPath(x(b.t), pad.t + ih - h, bw, h, Math.min(2, bw / 2, h))}"/>`;
    }
    svg += `<rect class="pl-hit" x="${pad.l}" y="0" width="${iw}" height="${H}"/><line class="pl-cross hidden" y1="0" y2="${H}"/></svg><div class="us-tip hidden"></div>`;
    el.innerHTML = svg;
    el.dataset.geom = JSON.stringify({ x0, x1, l: pad.l, iw });
  }

  // 2 つのグラフで同じ時刻に十字線を出し、近い記録と時間ごとのコストを見せる
  function onPlanHover(e) {
    const p = P.data;
    const charts = [$('#pl-chart'), $('#pl-bars')];
    const host = e.currentTarget;
    const g = host.dataset.geom && JSON.parse(host.dataset.geom);
    const box = host.getBoundingClientRect();
    const px = e.clientX - box.left;
    const inside = g && e.type === 'mousemove' && px >= g.l && px <= g.l + g.iw;
    for (const c of charts) {
      const cr = c.querySelector('.pl-cross');
      const tip = c.querySelector('.us-tip');
      if (cr) { cr.classList.toggle('hidden', !inside); cr.setAttribute('x1', px); cr.setAttribute('x2', px); }
      if (tip && c !== host) tip.classList.add('hidden');
    }
    const tip = host.querySelector('.us-tip');
    if (!tip) return;
    if (!inside) { tip.classList.add('hidden'); return; }
    const t = g.x0 + ((px - g.l) / g.iw) * (g.x1 - g.x0);
    const rows = [];
    const near = (p.history || []).reduce((best, h) => (Math.abs(h.t - t) < Math.abs((best ? best.t : Infinity) - t) ? h : best), null);
    if (near && Math.abs(near.t - t) < 3 * 3600e3) {
      for (const l of p.limits) {
        if (Number.isFinite(near.v[l.kind])) rows.push(`<div><i class="us-sw ${SERIES[l.group] || ''}"></i>${esc(l.label)}<b>${Math.round(near.v[l.kind])}%</b></div>`);
      }
    }
    const w = p.windows && p.windows.weekly;
    const b = w && w.buckets[Math.floor((t - w.from) / w.bucketMs)];
    if (b) rows.push(`<div class="us-tip-total">この 1 時間の API 換算<b>${fmtUsd(b.cost)}</b></div>`);
    rows.push(`<div>均等ペース<b>${Math.round(((t - g.x0) / (g.x1 - g.x0)) * 100)}%</b></div>`);
    tip.innerHTML = `<strong>${esc(clock(near && Math.abs(near.t - t) < 3 * 3600e3 ? near.t : t))}</strong>${rows.join('')}`;
    tip.classList.remove('hidden');
    const left = px + 12;
    tip.style.left = `${left + tip.offsetWidth > box.width - 4 ? px - tip.offsetWidth - 12 : left}px`;
    tip.style.top = '4px';
  }

  for (const id of ['#pl-chart', '#pl-bars']) {
    $(id).addEventListener('mousemove', onPlanHover);
    $(id).addEventListener('mouseleave', onPlanHover);
  }
  $('#pl-reload').addEventListener('click', () => loadPlan(true));
  $('#pl-billing').parentElement.addEventListener('click', (e) => {
    if (e.target.id !== 'pl-to-settings') return;
    e.preventDefault();
    document.querySelector('#subnav .subtab[data-tab="settings"]')?.click(); // 設定は同じ「管理」の中のタブ
  });

  $('#us-chart').addEventListener('mousemove', onHover);
  $('#us-chart').addEventListener('mouseleave', () => onHover({ target: document.body }));
  $('#us-days').addEventListener('change', () => load());
  $('#us-source').addEventListener('change', () => load());
  $('#us-reload').addEventListener('click', () => { load(true); loadPlan(true); });

  window.UsageView = {
    show() {
      if (S.visible) return;
      S.visible = true;
      load();
      loadPlan();
      S.timer = setInterval(() => { load(); loadPlan(); }, 60000); // 開いている間は 1 分ごとに読み直す
      if (!S.resizeObs && window.ResizeObserver) {
        S.resizeObs = new ResizeObserver(() => {
          if (S.visible && S.data) renderChart(FAMILIES.filter((f) => S.data.daily.some((x) => x.families[f.key])));
          if (S.visible && P.data) { renderPlanChart(); renderPlanBars(); }
        });
        S.resizeObs.observe($('#us-chart'));
      }
    },
    // クラウドセッションを読み直したとき
    onCloud() { if (S.visible) load(); },
    // サーバーからの知らせ(推移は含まないので、記録済みの推移と期間のコストは残す)
    onPlan(p) {
      if (!S.visible || !P.data) return;
      P.data = { ...P.data, ...p, history: P.data.history, windows: P.data.windows, month: P.data.month };
      renderPlan();
    },
    hide() {
      S.visible = false;
      clearInterval(S.timer);
      S.timer = null;
    },
  };
}());
