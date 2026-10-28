'use strict';
// 安全まわりの純粋な関数(サーバーの状態を持たない。テストしやすいように分けている)
// - 承認ゲート: 危ない操作(強制 push・公開・外部への送信・再帰削除)のコマンドを見分ける
// - safety_event: Claude Code の OpenTelemetry(OTLP/HTTP JSON)のログから「止められた操作」を取り出す

// 既定で承認を求めるコマンド(正規表現の文字列。設定画面で書き換えられる)
// 通常の `git push` は夜のルーティンなどが使うので含めない
const DEFAULT_APPROVAL_PATTERNS = [
  String.raw`\bgit\s+push\b.*\s(--force(-with-lease)?|-f)\b`,
  String.raw`\bgh\s+(pr\s+(create|merge)|release\s+create|repo\s+(delete|create))\b`,
  String.raw`\bnpm\s+publish\b`,
  String.raw`\bcurl\b.*\s(-X\s*(POST|PUT|PATCH|DELETE)|-d|--data[\w-]*|-F|--form|-T|--upload-file)\b`,
  String.raw`\brm\s+-[a-zA-Z]*(rf|fr)[a-zA-Z]*\b`,
  String.raw`\bInvoke-(RestMethod|WebRequest)\b.*-Method\s+(Post|Put|Patch|Delete)\b`,
  String.raw`\bRemove-Item\b.*-Recurse\b`,
];

const MAX_PATTERNS = 50;
const MAX_MATCH_LEN = 2000; // 一致判定はコマンドの先頭だけ(正規表現を本体のイベントループで回すため)
// 量指定子の付いたグループにさらに量指定子が付くもの((a+)+ など)。破局的バックトラックでサーバーが固まるので拒否する
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;

// 設定画面から来たパターンの検査。不正な正規表現があればエラー
function normalizePatterns(list) {
  if (!Array.isArray(list)) throw new Error('パターンは配列で指定してください');
  const out = [];
  for (const raw of list.slice(0, MAX_PATTERNS)) {
    const p = String(raw ?? '').trim();
    if (!p) continue;
    if (p.length > 300) throw new Error(`パターンが長すぎます: ${p.slice(0, 40)}…`);
    try { new RegExp(p, 'i'); } catch (e) { throw new Error(`正規表現が不正です: ${p}(${e.message})`); }
    if (NESTED_QUANTIFIER.test(p)) throw new Error(`量指定子を入れ子にしたパターンは使えません(処理が止まるおそれ): ${p}`);
    out.push(p);
  }
  return out;
}

// 一致した最初のパターンを返す(なければ null)。壊れたパターンは無視する
function matchApproval(command, patterns) {
  const cmd = String(command || '').slice(0, MAX_MATCH_LEN);
  if (!cmd) return null;
  for (const p of patterns || []) {
    let re;
    try { re = new RegExp(p, 'i'); } catch (_) { continue; }
    if (re.test(cmd)) return p;
  }
  return null;
}

// OTLP の AnyValue を素の値にする
function anyValue(v) {
  if (!v || typeof v !== 'object') return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return String(v.intValue);
  if ('doubleValue' in v) return String(v.doubleValue);
  if ('boolValue' in v) return String(v.boolValue);
  return undefined;
}

function attrs(list) {
  const out = {};
  for (const a of Array.isArray(list) ? list : []) {
    if (a && typeof a.key === 'string') {
      const v = anyValue(a.value);
      if (v !== undefined) out[a.key] = String(v).slice(0, 300);
    }
  }
  return out;
}

// OTLP/HTTP JSON のログ(ExportLogsServiceRequest)から claude_code.safety_event だけを取り出す
function parseSafetyEvents(body) {
  const events = [];
  for (const rl of Array.isArray(body?.resourceLogs) ? body.resourceLogs : []) {
    const resource = attrs(rl?.resource?.attributes);
    for (const sl of Array.isArray(rl?.scopeLogs) ? rl.scopeLogs : []) {
      for (const r of Array.isArray(sl?.logRecords) ? sl.logRecords : []) {
        const a = attrs(r?.attributes);
        const bodyName = anyValue(r?.body);
        if (a['event.name'] !== 'safety_event' && bodyName !== 'claude_code.safety_event') continue;
        events.push({ ...resource, ...a });
      }
    }
  }
  return events;
}

// 監査ログ 1 行分の要約
function describeSafetyEvent(e) {
  return {
    tool: e.tool_name || e.tool_class || '?',
    target: [e.category, e.decision].filter(Boolean).join(' / '),
    detail: [
      e.reason_code, e.circuit_breaker && `circuit:${e.circuit_breaker}`, e.permission_mode && `mode:${e.permission_mode}`,
      e.rule_source && `rule:${e.rule_source}`,
    ].filter(Boolean).join(' / '),
  };
}

module.exports = { DEFAULT_APPROVAL_PATTERNS, normalizePatterns, matchApproval, parseSafetyEvents, describeSafetyEvent };
