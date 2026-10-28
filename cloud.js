'use strict';
// クラウドセッション(claude.ai/code・スマホアプリなどで Anthropic のサーバー上で動く Claude Code)の使用量を読む。
//   - Claude Code のログイン情報で api.anthropic.com の /v1/sessions(一覧)と /v1/sessions/<id>/events を読む
//   - ターンの終わりの result 行にある modelUsage(モデル別のトークン数と costUSD = Claude Code 自身の計算)を使う。
//     modelUsage は「そのプロセスが始まってからの累計」なので、前の result との差をそのターンの分とする
//     (値が減ったらプロセスが作り直されたとみなし、0 から数え直す)。assistant 行の usage は出力トークンが
//     途中の値のことがあるので使わない
//   - 読んだところ(最後のイベント ID)を覚えて追記分だけ読み、~/.claude-galaxy/cloud-usage.json に残す
//   - 10 分ごとに読む。1 回に読むページ数には上限を設け、初回の取り込みは数回に分けて進める

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');
const { readCredentials } = require('./plan');

const FILE = path.join(DATA_DIR, 'cloud-usage.json');
const API = 'https://api.anthropic.com';
const POLL_MS = 10 * 60 * 1000;
const MIN_REFRESH_MS = 60 * 1000;
const PAGE = 1000; // events 1 ページの件数
const MAX_PAGES = 30; // 1 回の更新で読む events のページ数の上限
const VERSION = 3; // cloud-usage.json の形(3: result 行の差分で数える)

const repoOf = (s) => {
  const ctx = s.session_context || {};
  const out = (ctx.outcomes || []).find((o) => o && o.git_info && o.git_info.repo);
  if (out) return { repo: out.git_info.repo, branch: (out.git_info.branches || [])[0] || '' };
  const src = (ctx.sources || []).find((x) => x && x.url);
  const m = src && /github\.com\/([^/]+\/[^/.]+)/.exec(src.url);
  return { repo: m ? m[1] : '', branch: '' };
};

function createCloudUsage({ readCreds = readCredentials, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), onChange = () => {} } = {}) {
  let state = { v: VERSION, org: '', sessions: {} };
  try { state = { org: '', sessions: {}, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (_) { /* 初回 */ }
  if (state.v !== VERSION) state = { v: VERSION, org: state.org || '', sessions: {} }; // 記録の形が変わったら読み直す
  let error = '';
  let fetchedAt = 0;
  let lastTry = 0;
  let inflight = null;
  let saveTimer = null;
  let timer = null;

  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(state));
      } catch (e) { console.error('cloud-usage.json を保存できません:', e.message); }
    }, 1000);
    saveTimer.unref();
  }

  async function get(url, token, beta) {
    const headers = { Authorization: `Bearer ${token}`, 'anthropic-beta': beta, 'anthropic-version': '2023-06-01' };
    if (state.org) headers['x-organization-uuid'] = state.org;
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30000) });
    if (res.status === 401) throw new Error('ログイン情報の期限が切れています。Claude Code を一度使うと更新されます');
    if (!res.ok) throw Object.assign(new Error(`Anthropic の応答が HTTP ${res.status} でした`), { status: res.status });
    return res.json();
  }

  async function sync() {
    try { return await syncAll(); } finally { save(); } // 途中で失敗しても、読めたところまでは残す
  }

  async function syncAll() {
    const cred = readCreds();
    if (!cred) throw new Error('Claude Code のログイン情報が見つかりません(claude でログインすると読めるようになります)');
    const tok = cred.accessToken;
    if (!state.org) {
      const p = await get(`${API}/api/oauth/profile`, tok, 'oauth-2025-04-20');
      state.org = (p && p.organization && p.organization.uuid) || '';
      if (!state.org) throw new Error('組織の情報を読めませんでした');
    }
    // 一覧(ページ送りは after_id)
    const list = [];
    let after = '';
    for (let i = 0; i < 20; i++) {
      const j = await get(`${API}/v1/sessions${after ? `?after_id=${encodeURIComponent(after)}` : ''}`, tok, 'ccr-byoc-2025-07-29');
      list.push(...(j.data || []));
      if (!j.has_more || !j.last_id) break;
      after = j.last_id;
    }
    const alive = new Set();
    for (const s of list) {
      if (!s || !s.id) continue;
      alive.add(s.id);
      const u = (s.external_metadata && s.external_metadata.usage) || {};
      const prev = state.sessions[s.id] || { turns: {}, cum: {}, lastEventId: '', syncedAt: '' };
      state.sessions[s.id] = {
        ...prev,
        id: s.id,
        title: s.title || '',
        ...repoOf(s),
        origin: s.origin || '',
        status: s.session_status || '',
        connection: s.connection_status || '',
        model: (s.external_metadata && s.external_metadata.last_served_model) || s.configured_model || '',
        url: s.session_url || `https://claude.ai/code/${s.id}`,
        created: Date.parse(s.created_at) || 0,
        updated: s.updated_at || '',
        // Claude Code 自身が数えた累計(イベントを読み終える前の目安と、突き合わせ用)
        meta: {
          cost: Number(u.cost_usd) || 0,
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheWrite: u.cache_write_tokens || 0,
          cacheRead: u.cache_read_tokens || 0,
        },
      };
    }
    // 消えたセッション(アーカイブなど)も使った分は残す。一覧に無いことだけ印を付ける
    for (const [id, s] of Object.entries(state.sessions)) s.archived = !alive.has(id);

    // 更新されたセッションの events を追記分だけ読む(新しく更新されたものから)
    let pages = 0;
    // 読めなかったセッションは、次に更新されるまで読み直さない(ページの上限を使い切って、ほかが読めなくなるのを防ぐ)
    const todo = Object.values(state.sessions).filter((s) => !s.archived && s.syncedAt !== s.updated && s.failedAt !== s.updated)
      .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    for (const s of todo) {
      let done = false;
      try {
        while (pages < MAX_PAGES) {
          pages += 1;
          const q = `limit=${PAGE}${s.lastEventId ? `&after_id=${encodeURIComponent(s.lastEventId)}` : ''}`;
          const j = await get(`${API}/v1/sessions/${encodeURIComponent(s.id)}/events?${q}`, tok, 'ccr-byoc-2025-07-29');
          for (const e of j.data || []) if (e && e.type === 'result') addResult(s, e);
          if (j.last_id && (j.data || []).length) s.lastEventId = j.last_id;
          if (!j.has_more) { done = true; break; }
        }
      } catch (e) {
        // そのセッションだけ読めない(消えた・権限が無いなど 4xx)なら、ほかのセッションは読み進める。
        // ログイン切れ・接続できない・混雑(429)・サーバーの不調(5xx)のときは止める
        if (!(e.status >= 400 && e.status < 500) || e.status === 429) throw e;
        s.failedAt = s.updated;
        s.failed = e.message;
        continue;
      }
      s.failedAt = '';
      s.failed = '';
      if (done) s.syncedAt = s.updated;
      if (pages >= MAX_PAGES) break;
    }
    const failed = Object.values(state.sessions).filter((s) => !s.archived && s.failedAt && s.failedAt === s.updated)
      .map((s) => `${s.title || s.id}: ${s.failed}`);
    return { more: pages >= MAX_PAGES, failed }; // more: まだ読み残しがある
  }

  // result 行 1 件を、前の result との差(モデルごと)として turns に足す。turns[id] = [時刻, モデル, input, output, cacheWrite, cacheRead, USD]
  function addResult(s, e) {
    const mu = e.modelUsage && typeof e.modelUsage === 'object' ? e.modelUsage : {};
    const cur = {};
    for (const [model, u] of Object.entries(mu)) {
      if (!u) continue;
      cur[model] = [u.inputTokens || 0, u.outputTokens || 0, u.cacheCreationInputTokens || 0, u.cacheReadInputTokens || 0, Number(u.costUSD) || 0];
    }
    if (!Object.keys(cur).length) return; // API を呼ぶ前に終わったターン(累計の区切りには使わない)
    const sumOf = (x) => Object.values(x).reduce((n, v) => n + v[4], 0);
    const prev = sumOf(cur) + 1e-9 < sumOf(s.cum || {}) ? {} : (s.cum || {}); // 減った = プロセスが作り直された
    const t = Date.parse(e.created_at || e.timestamp) || 0;
    for (const [model, v] of Object.entries(cur)) {
      const p = prev[model] || [0, 0, 0, 0, 0];
      const d = v.map((x, i) => Math.max(0, x - p[i]));
      if (d.some((x) => x > 0)) s.turns[`${e.uuid || t}:${model}`] = [t, model, ...d];
    }
    s.cum = cur;
  }

  async function refresh({ force = false } = {}) {
    if (inflight) return inflight;
    if (!force && now() - lastTry < MIN_REFRESH_MS) return status();
    lastTry = now();
    inflight = (async () => {
      let more = false;
      try {
        const r = await sync();
        more = r.more;
        error = r.failed.length ? `${r.failed.length} 件のセッションの記録を読めませんでした(${r.failed[0]})` : '';
        fetchedAt = now();
      } catch (e) {
        error = e.name === 'TimeoutError' ? 'Anthropic に接続できませんでした(タイムアウト)' : e.message;
      }
      onChange(status());
      // 初回の取り込みが残っていれば、少し置いて続きを読む
      if (more && timer) setTimeout(() => refresh({ force: true }), 5000).unref();
    })().finally(() => { inflight = null; });
    await inflight;
    return status();
  }

  // usage.js の集計に混ぜる形で、応答を 1 件ずつ返す
  function* messages() {
    for (const s of Object.values(state.sessions)) {
      const cwd = s.repo ? `☁ ${s.repo}` : '☁ クラウド';
      for (const [id, [t, model, input, output, cacheWrite, cacheRead, cost]] of Object.entries(s.turns || {})) {
        yield { id, session: s.id, cwd, m: { t, model, input, output, cacheWrite, cacheRead, cost } };
      }
    }
  }

  function sessions() {
    return Object.values(state.sessions).map(({ turns, cum, ...s }) => ({
      ...s,
      synced: s.syncedAt === s.updated,
      calls: Object.keys(turns || {}).length,
    })).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  }

  function status() {
    const list = sessions();
    return {
      ok: !!fetchedAt || list.length > 0,
      error,
      fetchedAt,
      count: list.filter((s) => !s.archived).length,
      pending: list.filter((s) => !s.archived && !s.synced).length,
    };
  }

  function start() {
    timer = setInterval(() => refresh({ force: true }), POLL_MS);
    timer.unref();
    refresh({ force: true });
  }

  return { refresh, messages, sessions, status, start };
}

module.exports = { createCloudUsage, repoOf };
