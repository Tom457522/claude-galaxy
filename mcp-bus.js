#!/usr/bin/env node
'use strict';
// Claude Galaxy の MCP サーバー(stdio)。Claude Code が --mcp-config で起動する。
// ツール呼び出しを Claude Galaxy 本体(127.0.0.1 の /api/bus)へ中継するだけで、状態は本体が持つ。
//   環境変数: GALAXY_PORT / GALAXY_TOKEN / GALAXY_SESSION(呼び出し元のエージェント ID)

const http = require('http');
const readline = require('readline');

const port = process.env.GALAXY_PORT;
const token = process.env.GALAXY_TOKEN;
const self = process.env.GALAXY_SESSION || '';

const PERMISSION_NOTE = 'permission_mode は plan / dontAsk / acceptEdits のいずれか(省略時は既定の権限。確認が要る操作は Claude Galaxy の受信箱で人が答え、答えがなければ拒否)';

const TOOLS = [
  {
    name: 'list_agents',
    description: 'Claude Galaxy で動いているエージェント(対話セッションとジョブ)の一覧と、自分の ID を返す。メッセージの宛先を調べるときに使う。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'send_message',
    description: 'ほかのエージェントか人(to: "user")にメッセージを送る。相手は read_messages で読む。to は list_agents の ID か名前、"user"、"all"(全員)、"parent"(自分を登録したエージェント)。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '宛先(ID・名前・"user"・"all"・"parent")' },
        text: { type: 'string', description: '本文' },
        reply_to: { type: 'string', description: '返信元のメッセージ ID(任意)' },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_messages',
    description: '自分宛て(と全員宛て)のメッセージを読む。既定では未読だけを返し、既読にする。',
    inputSchema: {
      type: 'object',
      properties: { include_read: { type: 'boolean', description: '既読も含める' } },
      additionalProperties: false,
    },
  },
  {
    name: 'send_prompt',
    description: '入力待ち(待機中)の対話セッションに、プロンプトとして文章を入力して送信する。相手のエージェントにすぐ作業させたいときに使う。相手が作業中なら送らずエラーを返す。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '対話セッションの ID か名前' },
        text: { type: 'string', description: '入力する文章' },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_job',
    description: `Claude Code をヘッドレスで実行するジョブをキューに登録し、ジョブ ID を返す。作業を分担させるときに使う。結果は get_job で受け取る。${PERMISSION_NOTE}。`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'ジョブに渡す指示' },
        name: { type: 'string', description: '短い名前' },
        cwd: { type: 'string', description: '作業ディレクトリ(省略時は自分と同じ)' },
        model: { type: 'string', description: 'モデル(例: sonnet / opus / haiku)' },
        permission_mode: { type: 'string', enum: ['plan', 'dontAsk', 'acceptEdits'] },
        priority: { type: 'string', enum: ['high', 'normal', 'low'] },
        max_budget_usd: { type: 'number', description: 'このジョブで使ってよい上限(USD)' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_job',
    description: 'ジョブの状態と結果を返す。wait_seconds を指定すると、終わるまで最大その秒数待つ(最大 240)。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, wait_seconds: { type: 'number' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_jobs',
    description: 'ジョブの一覧(新しい順)。mine: true なら自分が登録したものだけ。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['queued', 'running', 'done', 'failed', 'canceled'] },
        mine: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_job',
    description: '自分が登録したジョブを中止する。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'memory_write',
    description: '共有メモリにキーと値を書く(同じキーは上書き)。決めたこと・調べた結果・作業の引き継ぎなど、ほかのエージェントにも見せたい知識を残す。キーは "project/topic" のように / で区切ると探しやすい。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_read',
    description: '共有メモリからキーを指定して読む。',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
  },
  {
    name: 'memory_search',
    description: '共有メモリを語で検索する(キー・値・タグの部分一致。空白区切りの語をすべて含むもの)。query を空にすると新しい順に一覧。prefix でキーの先頭を絞れる。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, prefix: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_delete',
    description: '共有メモリからキーを消す。',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
  },
];

function call(tool, args, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ from: self, tool, args: args || {} });
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/bus',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Galaxy-Token': token },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(data); } catch (_) { j = { error: data || `HTTP ${res.statusCode}` }; }
        resolve(res.statusCode === 200 ? { ok: true, value: j.result } : { ok: false, error: j.error || `HTTP ${res.statusCode}` });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: `Claude Galaxy に接続できません(${e.code || e.message})` }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Claude Galaxy の応答がありません' }); });
    req.end(body);
  });
}

function reply(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); }
function fail(id, code, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize': {
      const who = await call('whoami', {}, 5000);
      const me = who.ok ? who.value : null;
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-galaxy', version: '0.3.0' },
        instructions:
          'Claude Galaxy の共有バスです。複数の Claude(対話セッションとジョブ)が、メッセージ・共有メモリ・ジョブの登録で協力できます。' +
          (me ? `あなたのエージェント ID は ${me.id}(${me.name})です。${me.parent ? `あなたを登録したのは ${me.parent} です。終わったら send_message の to: "parent" で結果を報告してください。` : ''}` : '') +
          'ほかのエージェントに頼みたいときは submit_job、知識を残すときは memory_write、人に知らせたいときは send_message の to: "user" を使います。',
      });
    }
    case 'ping':
      return isRequest && reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params && params.name;
      if (!TOOLS.some((t) => t.name === name)) return fail(id, -32602, `unknown tool: ${name}`);
      const args = (params && params.arguments) || {};
      const waitMs = name === 'get_job' ? Math.min(240, Math.max(0, Number(args.wait_seconds) || 0)) * 1000 : 0;
      const r = await call(name, args, waitMs + 15000);
      const text = r.ok ? (typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2)) : r.error;
      return reply(id, { content: [{ type: 'text', text }], isError: !r.ok });
    }
    default:
      if (isRequest) fail(id, -32601, `method not found: ${method}`);
  }
}

if (!port || !token) {
  process.stderr.write('claude-galaxy MCP: GALAXY_PORT / GALAXY_TOKEN がありません\n');
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return fail(null, -32700, 'parse error'); }
  handle(msg).catch((e) => { if (msg.id !== undefined) fail(msg.id, -32603, e.message); });
});
rl.on('close', () => process.exit(0));
