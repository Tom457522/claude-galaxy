'use strict';
// おすすめ設定: 使い方の数値(使用量・プランの利用率・ジョブ・オートメーション)から、設定の変更案を作る。
//   - facts(): 本体が持っている数値だけを集めて、判断の材料にする(ファイルの中身やプロンプトは含めない)
//   - recommend(): 規則で変更案を作る(Claude を呼ばないので費用なし)
//   - preset(): 目的別のまとまった変更案(節約重視・無人ジョブ多め・安全重視)
//   - aiPrompt() / parseAi(): Claude に案の見直しと理由の説明を頼み、答えを決まった項目・範囲に絞って読む
// 変更案は画面で人が選んでから、通常の PUT /api/settings で保存する(ここでは保存しない)。

const fs = require('fs');
const os = require('os');
const path = require('path');

// おすすめの対象にする設定と、その型・範囲・表示名。ここに無い項目は案にしない(AI の答えも)
const KEYS = {
  budgetDailyUsd: { label: '1 日の上限(USD)', type: 'usd', min: 0, max: 100000, section: 'budget' },
  budgetJobUsd: { label: 'ジョブ 1 件の既定の上限(USD)', type: 'usd', min: 0, max: 100000, section: 'budget' },
  budgetSessionWarnUsd: { label: 'セッションの警告額(USD)', type: 'usd', min: 0, max: 100000, section: 'budget' },
  budgetIncludeCloud: { label: 'クラウドの使用額も上限に数える', type: 'bool', section: 'budget' },
  planLimitSessionPct: { label: '5 時間の制限で止める利用率(%)', type: 'pct', min: 0, max: 100, section: 'plan' },
  planLimitWeeklyPct: { label: '週間の制限で止める利用率(%)', type: 'pct', min: 0, max: 100, section: 'plan' },
  planPaceGuard: { label: '週のペースガード', type: 'bool', section: 'plan' },
  planPaceMargin: { label: 'ペースガードの幅(ポイント)', type: 'pct', min: 1, max: 50, section: 'plan' },
  notifyDesktop: { label: 'デスクトップ通知', type: 'bool', section: 'notify' },
  permissionInbox: { label: '権限確認を受信箱で答える', type: 'bool', section: 'notify' },
  approvalGate: { label: '承認ゲート', type: 'bool', section: 'notify' },
  maxConcurrentJobs: { label: 'ジョブの同時実行数', type: 'int', min: 1, max: 10, section: 'agent' },
  memoryLearn: { label: '学びを共有メモリの候補として出させる', type: 'bool', section: 'agent' },
  auditEnabled: { label: '監査ログを残す', type: 'bool', section: 'record' },
  auditDays: { label: '監査ログを保存する日数', type: 'days', min: 1, max: 365, section: 'record' },
  collectSafetyEvents: { label: '「止められた操作」を集める', type: 'bool', section: 'record' },
  // 書き出し先はパスなので、規則(見つかった Vault)だけが案にする。AI には決めさせない
  memoryExportVault: { label: '共有メモリの書き出し先', type: 'path', section: 'export', noAi: true },
  memoryExportMode: { label: '共有メモリの書き出し方', type: 'enum', values: ['off', 'files', 'push'], section: 'export', noAi: true },
};
const AUDIT_DAYS = [7, 30, 90, 365];
// KEYS 自身のキーか(constructor などの継承プロパティを通さない)
const isKey = (k) => Object.prototype.hasOwnProperty.call(KEYS, k);
const EXPORT_MODE = { off: '書き出さない', files: 'ファイルを書くだけ', push: 'コミットして push' };
const SUBSCRIPTION = ['pro', 'max', 'team', 'enterprise'];
const DAY = 24 * 60 * 60 * 1000;

// 値を型と範囲に合わせる(合わせられなければ undefined)
function sanitize(key, v) {
  if (!isKey(key)) return undefined;
  const k = KEYS[key];
  if (k.type === 'bool') return typeof v === 'boolean' ? v : undefined;
  if (k.type === 'path') return typeof v === 'string' && v.length <= 1000 ? v : undefined;
  if (k.type === 'enum') return k.values.includes(v) ? v : undefined;
  const n = Number(v);
  if (typeof v === 'boolean' || v === null || v === '' || !Number.isFinite(n)) return undefined;
  const c = Math.min(k.max, Math.max(k.min, n));
  if (k.type === 'usd') return Math.round(c * 100) / 100;
  if (k.type === 'days') return AUDIT_DAYS.reduce((a, b) => (Math.abs(b - c) < Math.abs(a - c) ? b : a));
  return Math.round(c);
}

function fmt(key, v) {
  if (!isKey(key)) return String(v);
  const k = KEYS[key];
  if (k.type === 'bool') return v ? 'オン' : 'オフ';
  if (k.type === 'usd') return Number(v) ? `$${Number(v).toFixed(Number(v) % 1 ? 2 : 0)}` : '上限なし';
  if (k.type === 'pct') {
    if (key === 'planPaceMargin') return `${v} ポイント`;
    return Number(v) ? `${v}%` : '100%(実際の上限)';
  }
  if (k.type === 'days') return `${v} 日`;
  if (k.type === 'path') return v || '(なし)';
  if (k.type === 'enum') return EXPORT_MODE[v] || String(v);
  return String(v);
}

// 切りのよい値に切り上げる($1 / $5 / $10 / $50 刻み)
function niceUp(v) {
  if (!(v > 0)) return 0;
  const step = v < 5 ? 1 : v < 50 ? 5 : v < 200 ? 10 : 50;
  return Math.ceil(v / step) * step;
}

function quantile(arr, q) {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1));
  return a[i];
}

// ホーム直下と ~/Documents 直下で、Obsidian の Vault(.obsidian フォルダがある)を探す
function findVaults(home = os.homedir()) {
  const out = [];
  for (const base of [home, path.join(home, 'Documents')]) {
    let ents = [];
    try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { continue; }
    for (const d of ents) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      const p = path.join(base, d.name);
      try { if (fs.statSync(path.join(p, '.obsidian')).isDirectory()) out.push(p); } catch (_) { /* ignore */ }
      if (out.length >= 5) return out;
    }
  }
  return out;
}

// 判断の材料。すべて数値・件数・設定値で、ファイルの中身・プロンプト・パスは含めない(Vault の候補だけはパス)
function facts({ settings = {}, usage = null, plan = null, jobs = [], automations = [], vaults = [], now = Date.now() } = {}) {
  const daily = usage && Array.isArray(usage.daily) ? usage.daily.map((d) => Number(d.cost) || 0) : [];
  const active = daily.filter((c) => c > 0.01);
  const sessionCosts = usage && Array.isArray(usage.sessions) ? usage.sessions.map((s) => Number(s.cost) || 0).filter((c) => c > 0) : [];
  const recentJobs = jobs.filter((j) => (j.createdAt || 0) >= now - 30 * DAY);
  const jobCosts = recentJobs.map((j) => Number(j.costUsd) || 0).filter((c) => c > 0);
  const enabledAutos = automations.filter((a) => a && a.enabled);
  const autoModes = enabledAutos.map((a) => (a.template && a.template.permissionMode) || '');
  const limits = plan && Array.isArray(plan.limits) ? plan.limits : [];
  const hist = plan && Array.isArray(plan.history) ? plan.history : [];
  const peak = (group) => {
    let m = 0;
    for (const h of hist) for (const [k, v] of Object.entries(h.v || {})) if ((group === 'weekly') === String(k).startsWith('weekly')) m = Math.max(m, Number(v) || 0);
    for (const l of limits) if (l.group === group) m = Math.max(m, Number(l.percent) || 0);
    return Math.round(m);
  };
  const r2 = (v) => Math.round(v * 100) / 100;
  const planType = plan && plan.plan ? String(plan.plan.type || '').toLowerCase() : '';
  return {
    plan: {
      known: !!(plan && plan.ok),
      name: plan && plan.plan ? plan.plan.name : '',
      subscription: SUBSCRIPTION.includes(planType),
      type: planType,
      sessionPct: Math.round(Number((limits.find((l) => l.group === 'session') || {}).percent) || 0),
      weeklyPct: Math.round(Number((limits.find((l) => l.group === 'weekly') || {}).percent) || 0),
      sessionPeak: peak('session'),
      weeklyPeak: peak('weekly'),
    },
    usage: {
      days: daily.length,
      activeDays: active.length,
      avgDaily: r2(active.length ? active.reduce((a, b) => a + b, 0) / active.length : 0),
      p90Daily: r2(quantile(active, 0.9)),
      maxDaily: r2(active.length ? Math.max(...active) : 0),
      cloudCost: r2(usage && usage.totals ? Number(usage.totals.cloud) || 0 : 0),
      sessions: sessionCosts.length,
      p90Session: r2(quantile(sessionCosts, 0.9)),
    },
    jobs: {
      last30: recentJobs.length,
      fromAutomation: recentJobs.filter((j) => j.source === 'automation').length,
      fromAgent: recentJobs.filter((j) => j.source === 'agent').length,
      editing: recentJobs.filter((j) => ['acceptEdits', 'bypassPermissions', 'auto'].includes(j.permissionMode)).length,
      blocked: recentJobs.filter((j) => j.blockedBy).length,
      p90Cost: r2(quantile(jobCosts, 0.9)),
      maxCost: r2(jobCosts.length ? Math.max(...jobCosts) : 0),
    },
    automations: {
      enabled: enabledAutos.length,
      editing: autoModes.filter((m) => ['acceptEdits', 'bypassPermissions', 'auto'].includes(m)).length,
    },
    vaults: vaults.slice(0, 5),
    // おすすめの対象の設定の、いまの値(パス・正規表現などは含めない)
    settings: Object.fromEntries(Object.keys(KEYS).filter((k) => !KEYS[k].noAi).map((k) => [k, settings[k]])),
  };
}

// 変更案 1 件を作る(いまの値と同じ項目は落とす。全部同じなら null)
function item(settings, { id, title, patch, reason, priority = 'mid', source = 'rule' }) {
  const changes = [];
  const clean = {};
  for (const [k, v] of Object.entries(patch)) {
    const to = sanitize(k, v);
    if (to === undefined) continue;
    const from = settings[k];
    if (from === to || (from === undefined && to === false)) continue;
    clean[k] = to;
    changes.push({ key: k, label: KEYS[k].label, section: KEYS[k].section, from: from ?? null, to, fromText: fmt(k, from), toText: fmt(k, to) });
  }
  if (!changes.length) return null;
  return { id, title, patch: clean, changes, reason, priority, source };
}

// 規則で変更案を作る
function recommend(f, settings = {}) {
  const out = [];
  const add = (x) => { const it = item(settings, x); if (it) out.push(it); };
  const u = f.usage;
  const sub = f.plan.subscription;
  const unattended = f.automations.enabled > 0 || f.jobs.fromAutomation > 0 || f.jobs.fromAgent > 0;
  const editingUnattended = f.automations.editing > 0 || f.jobs.editing > 0;

  // 安全
  if (!settings.approvalGate && (editingUnattended || unattended)) {
    add({ id: 'approval-gate', priority: 'high', title: '危ないコマンドは承認してから実行する',
      patch: { approvalGate: true },
      reason: `${f.automations.enabled ? `有効なオートメーションが ${f.automations.enabled} 件` : `直近 30 日に無人のジョブが ${f.jobs.fromAutomation + f.jobs.fromAgent} 件`}あります。強制 push・公開・外部送信などは、許可済みでも受信箱で承認するまで止めておくと安心です。` });
  }
  if (settings.permissionInbox === false) {
    add({ id: 'inbox', priority: 'mid', title: '権限確認を受信箱で答える', patch: { permissionInbox: true },
      reason: 'ターミナルを開かなくても、サイドバーの受信箱から許可・拒否できるようになります。複数のセッションを並べるときに便利です。' });
  }
  if (settings.notifyDesktop === false) {
    add({ id: 'notify', priority: 'mid', title: 'デスクトップ通知をオンにする', patch: { notifyDesktop: true },
      reason: '承認待ちやジョブの完了に気づけず、作業が止まったままになるのを防ぎます。' });
  }
  if (settings.auditEnabled === false && (unattended || f.jobs.last30 > 0)) {
    add({ id: 'audit', priority: 'mid', title: '監査ログを残す', patch: { auditEnabled: true },
      reason: 'エージェントが何を実行したかを後から確かめられます(ファイルの中身は残しません)。' });
  }
  if (!settings.collectSafetyEvents && editingUnattended) {
    add({ id: 'safety', priority: 'low', title: '「止められた操作」を集める', patch: { collectSafetyEvents: true },
      reason: 'ファイルを書き換える無人ジョブがあるので、Claude Code が安全のために止めた操作も記録に残すと見直しやすくなります。' });
  }

  // 予算(定額プランでは API 換算の概算なので、暴走よけとして控えめに)
  if (!Number(settings.budgetDailyUsd) && u.activeDays >= 3) {
    const v = Math.max(5, niceUp(u.p90Daily * 1.5));
    add({ id: 'budget-daily', priority: sub ? 'low' : 'high', title: '1 日の上限を決める', patch: { budgetDailyUsd: v },
      reason: `直近 ${u.days} 日で、多い日(上位 10%)の使用額は $${u.p90Daily.toFixed(2)} でした。その 1.5 倍を上限にすると、ふだんは止まらず、暴走したジョブだけを止められます。${sub ? '定額プランなので請求額ではなく API 換算の目安です。' : ''}` });
  } else if (Number(settings.budgetDailyUsd) && u.activeDays >= 5 && u.p90Daily > Number(settings.budgetDailyUsd)) {
    const v = niceUp(u.p90Daily * 1.2);
    add({ id: 'budget-daily-up', priority: 'mid', title: '1 日の上限を見直す', patch: { budgetDailyUsd: v },
      reason: `いまの上限 $${settings.budgetDailyUsd} を、多い日(上位 10%)の $${u.p90Daily.toFixed(2)} が超えています。ジョブが止まりやすいので、少し上げることをおすすめします。` });
  }
  if (!Number(settings.budgetJobUsd) && f.jobs.last30 >= 3) {
    const v = Math.max(1, niceUp((f.jobs.p90Cost || 0.5) * 2));
    add({ id: 'budget-job', priority: unattended ? 'mid' : 'low', title: 'ジョブ 1 件の上限を決める', patch: { budgetJobUsd: v },
      reason: `直近 30 日のジョブ ${f.jobs.last30} 件のうち、多いもの(上位 10%)は $${f.jobs.p90Cost.toFixed(2)} でした。その 2 倍を既定の上限にすると、ループしたジョブを早めに止められます。` });
  }
  if (!Number(settings.budgetSessionWarnUsd) && u.sessions >= 5 && u.p90Session > 0) {
    const v = Math.max(1, niceUp(u.p90Session));
    add({ id: 'budget-session', priority: 'low', title: 'セッションの警告額を決める', patch: { budgetSessionWarnUsd: v },
      reason: `コストの大きいセッションの上位 10% が $${u.p90Session.toFixed(2)} です。これを超えたセッションが赤く表示され、長引いている作業に気づけます。` });
  }
  if (settings.budgetIncludeCloud === false && u.cloudCost > 0) {
    add({ id: 'budget-cloud', priority: 'low', title: 'クラウドの使用額も上限に数える', patch: { budgetIncludeCloud: true },
      reason: `直近の期間にクラウドセッションで $${u.cloudCost.toFixed(2)} 使っています。合わせて数えないと、1 日の上限が実際より緩くなります。` });
  }

  // プランの制限(定額プランのとき)
  if (sub && f.plan.known) {
    if (unattended && !Number(settings.planLimitWeeklyPct)) {
      add({ id: 'plan-weekly', priority: 'high', title: '週の枠を 2 割残して無人ジョブを止める', patch: { planLimitWeeklyPct: 80 },
        reason: '無人のジョブが週の枠を使い切ると、週末まで手で Claude を使えなくなります。週間の利用率が 80% に達したら新しいジョブを待たせ、残りを手作業用に取っておきます。' });
    }
    if (unattended && !Number(settings.planLimitSessionPct)) {
      add({ id: 'plan-session', priority: 'mid', title: '5 時間の枠を少し残す', patch: { planLimitSessionPct: 90 },
        reason: 'ジョブが 5 時間の枠を使い切ると、そのあいだ対話セッションも待たされます。90% でジョブを待たせると、手で使う分が残ります。' });
    }
    if (!settings.planPaceGuard && f.plan.weeklyPeak >= 90) {
      add({ id: 'plan-pace', priority: 'mid', title: '週のペースガードをオンにする', patch: { planPaceGuard: true, planPaceMargin: 10 },
        reason: `週間の利用率が ${f.plan.weeklyPeak}% まで上がったことがあります。週の途中で使いすぎていたら、ジョブを自動で待たせます。` });
    }
    const max = Number(settings.maxConcurrentJobs) || 2;
    if (f.plan.type === 'pro' && max > 1 && f.jobs.last30 > 0) {
      add({ id: 'concurrency-pro', priority: 'low', title: 'ジョブは 1 件ずつ動かす', patch: { maxConcurrentJobs: 1 },
        reason: 'Pro プランは 5 時間の枠が小さいので、ジョブを並べると枠をすぐ使い切ります。' });
    } else if (/20x/i.test(f.plan.name) && max < 3 && f.jobs.last30 >= 20 && f.plan.weeklyPeak < 70) {
      add({ id: 'concurrency-up', priority: 'low', title: 'ジョブの同時実行数を増やす', patch: { maxConcurrentJobs: 3 },
        reason: `Max 20x で週の利用率に余裕があり(最大 ${f.plan.weeklyPeak}%)、ジョブも多い(30 日で ${f.jobs.last30} 件)ので、3 件まで同時に動かすと早く終わります。` });
    }
  }

  // 共有メモリの書き出し(Vault が見つかったとき)
  if (!settings.memoryExportVault && f.vaults.length) {
    add({ id: 'export-vault', priority: 'low', title: 'Obsidian の Vault に共有メモリを書き出す',
      patch: { memoryExportVault: f.vaults[0], memoryExportMode: 'files' },
      reason: `Obsidian の Vault(${path.basename(f.vaults[0])})が見つかりました。確認済みの共有メモリを 1 項目 1 ノートで書き出すと、スマホやクラウドのタスクからも読めます(push はしません)。` });
  }

  const rank = { high: 0, mid: 1, low: 2 };
  return out.sort((a, b) => rank[a.priority] - rank[b.priority]);
}

// 目的別のまとまった変更案
const PRESETS = {
  save: { title: '節約重視', description: '使いすぎを防ぎ、プランの枠を残します',
    patch: { planLimitWeeklyPct: 70, planLimitSessionPct: 80, planPaceGuard: true, planPaceMargin: 5, maxConcurrentJobs: 1 } },
  unattended: { title: '無人ジョブ多め', description: 'オートメーションを安心して回すための設定です',
    patch: { approvalGate: true, permissionInbox: true, notifyDesktop: true, planLimitWeeklyPct: 85, planPaceGuard: true, maxConcurrentJobs: 3, auditEnabled: true, collectSafetyEvents: true } },
  safe: { title: '安全重視', description: '承認と記録を厚くします',
    patch: { approvalGate: true, permissionInbox: true, auditEnabled: true, auditDays: 90, collectSafetyEvents: true, maxConcurrentJobs: 1 } },
};

function preset(name, f, settings = {}) {
  const p = PRESETS[name];
  if (!p) throw new Error(`プリセットが不正です: ${name}`);
  const patch = { ...p.patch };
  // ジョブの上限が無ければ、使い方に合わせて足す
  if (!Number(settings.budgetJobUsd) && (name === 'save' || name === 'unattended')) patch.budgetJobUsd = Math.max(1, niceUp((f.jobs.p90Cost || 0.5) * (name === 'save' ? 1.5 : 2)));
  const it = item(settings, { id: `preset-${name}`, title: p.title, patch, reason: p.description, priority: 'mid', source: 'preset' });
  return it ? [it] : [];
}

const presets = () => Object.entries(PRESETS).map(([id, p]) => ({ id, title: p.title, description: p.description }));

// Claude への依頼文。数値と設定値だけを渡す(書き出し先など、パスを含む案は渡さない)
function aiPrompt(f, rules) {
  const keys = Object.entries(KEYS).filter(([, k]) => !k.noAi)
    .map(([key, k]) => `- ${key}: ${k.label}(${k.type === 'bool' ? 'true / false' : k.type === 'days' ? AUDIT_DAYS.join(' / ') : `${k.min}〜${k.max}`}${k.type === 'usd' || k.type === 'pct' ? '。0 は上限なし' : ''})`);
  return [
    'あなたは Claude Galaxy(Claude Code を複数並べて動かすローカルアプリ)の設定アドバイザーです。',
    '下の「使い方の数値」と「いまの設定」から、この人に合う設定の変更を提案してください。作業そのものはしないでください。',
    '',
    '## 変えてよい設定(これ以外のキーは使わない)',
    ...keys,
    '',
    '## 使い方の数値(JSON)',
    JSON.stringify({ ...f, vaults: undefined }, null, 1),
    '',
    '## 規則で作った案(参考。良ければ採用し、違うと思えば外すか値を変える)',
    JSON.stringify(rules.filter((r) => !Object.keys(r.patch).some((k) => KEYS[k].noAi)).map((r) => ({ id: r.id, patch: r.patch, reason: r.reason })), null, 1),
    '',
    '## 考え方',
    '- 定額プラン(subscription: true)では USD の予算は請求額ではなく API 換算の目安。プランの利用率の制限のほうが大事',
    '- 無人のジョブ・オートメーションがあるなら、承認ゲート・枠の確保・ジョブの上限を重く見る',
    '- 変える必要のない設定は出さない。根拠は上の数値だけにし、数値を作らない',
    '',
    '## 答え方',
    'JSON だけを返す。説明文やコードブロックは付けない。',
    '{"summary": "この人の使い方の要約と、全体の方針(日本語で 2 文以内)", "items": [{"id": "英小文字とハイフンの短い名前", "title": "日本語で 25 文字以内", "patch": {"設定キー": 値}, "reason": "日本語で 2 文以内。数値を根拠に", "priority": "high | mid | low"}]}',
    'items は 8 件まで。',
  ].join('\n');
}

// Claude の答えを読む。知らないキー・範囲外の値・いまと同じ値は落とす
function parseAi(raw, settings = {}) {
  const m = /\{[\s\S]*\}/.exec(String(raw || ''));
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch (_) { return null; }
  if (!j || typeof j !== 'object') return null;
  const items = [];
  const seen = new Set();
  for (const x of Array.isArray(j.items) ? j.items.slice(0, 8) : []) {
    if (!x || typeof x !== 'object' || !x.patch || typeof x.patch !== 'object') continue;
    const patch = {};
    for (const [k, v] of Object.entries(x.patch)) if (isKey(k) && !KEYS[k].noAi) patch[k] = v;
    let id = String(x.id || '').toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^rule-/, '').slice(0, 40) || `ai-${items.length + 1}`;
    while (seen.has(id)) id += '-2';
    const it = item(settings, {
      id, patch, source: 'ai',
      title: String(x.title || '').slice(0, 60) || 'Claude の提案',
      reason: String(x.reason || '').slice(0, 400),
      priority: ['high', 'mid', 'low'].includes(x.priority) ? x.priority : 'mid',
    });
    if (it) { seen.add(id); items.push(it); }
  }
  return { summary: String(j.summary || '').slice(0, 400), items };
}

module.exports = { KEYS, sanitize, fmt, niceUp, quantile, findVaults, facts, recommend, preset, presets, aiPrompt, parseAi };
