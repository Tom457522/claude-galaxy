'use strict';
// 結合テスト: 本物の server.js を、偽の claude(test/fixtures/bin/claude)で起動して API を通して確かめる
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'bin', 'claude');
const skip = process.platform === 'win32' ? '結合テストは macOS / Linux のみ' : false;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-it-'));
let server = null;
let base = '';

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function start() {
  const port = await freePort();
  const appsPort = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, PORT: String(port), APPS_PORT: String(appsPort), SHELL: '/bin/bash', CLAUDE_CMD: FAKE, GALAXY_PERMISSION_WAIT: '20' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (c) => { log += c; });
  server.stderr.on('data', (c) => { log += c; });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/api/settings`); return; } catch (_) { await sleep(100); }
  }
  throw new Error(`server did not start:\n${log}`);
}

function stop() {
  return new Promise((resolve) => {
    if (!server || server.exitCode !== null) return resolve();
    server.on('exit', () => resolve());
    server.kill('SIGTERM');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function waitFor(fn, { timeout = 15000, label = '' } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timeout: ${label}`);
    await sleep(150);
  }
}

const job = async (id) => (await api('GET', '/api/jobs')).jobs.find((j) => j.id === id);
const finished = (id) => waitFor(async () => { const j = await job(id); return j && !['queued', 'running'].includes(j.status) && j; }, { label: `job ${id}` });

test('Claude Galaxy サーバー', { skip }, async (t) => {
  await start();
  t.after(stop);

  await t.test('対話セッション: --settings と --mcp-config を付けて起動し、保存される', async () => {
    const s = await api('POST', '/api/sessions', { name: 'lead', cwd: home });
    assert.strictEqual(s.injected, true);
    const logFile = path.join(home, '.claude-galaxy', 'logs', `${s.id}.log`);
    const line = await waitFor(() => fs.existsSync(logFile) && /INTERACTIVE ARGS: .*/.exec(fs.readFileSync(logFile, 'utf8')), { label: 'pty output' });
    assert.match(line[0], /--mcp-config \S+mcp-\d+-s1\.json --settings \S+hooks-\d+\.json/);
    const file = path.join(home, '.claude-galaxy', 'sessions.json'); // 保存は 500ms まとめて行う
    const saved = await waitFor(() => fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')), { label: 'sessions.json' });
    assert.strictEqual(saved.sessions[0].name, 'lead');
  });

  await t.test('ジョブ: 共有バスの MCP ツールで、メッセージ・メモリ・子ジョブが動く', async () => {
    const child = 'child\nCALL send_message {"to":"parent","text":"child done"}';
    const prompt = [
      'CALL list_agents {}',
      'CALL memory_write {"key":"proj/x","value":"v1"}',
      'CALL send_message {"to":"user","text":"report"}',
      `CALL submit_job ${JSON.stringify({ prompt: child, name: 'child' })}`,
      'CALL submit_job {"prompt":"x","permission_mode":"bypassPermissions"}',
    ].join('\n');
    const j = await api('POST', '/api/jobs', { name: 'parent', cwd: home, prompt, model: 'sonnet', maxBudgetUsd: 1 });
    const done = await finished(j.id);
    assert.strictEqual(done.status, 'done', done.error);
    assert.strictEqual(done.costUsd, 0.0123);
    const results = JSON.parse(done.result);
    assert.match(results[0].text, new RegExp(`"you": "${j.id}"`));
    assert.strictEqual(results[4].isError, true); // 強い権限の子ジョブは拒否
    const childJob = (await api('GET', '/api/jobs')).jobs.find((x) => x.name === 'child');
    assert.strictEqual(childJob.parent, j.id);
    assert.strictEqual(childJob.depth, 1);
    await finished(childJob.id);
    const board = await waitFor(async () => { const b = await api('GET', '/api/board'); return b.messages.length >= 3 && b; }, { label: 'messages' });
    assert.ok(board.messages.some((m) => m.from === j.id && m.to === 'user'));
    assert.ok(board.messages.some((m) => m.from === childJob.id && m.to === j.id && m.text === 'child done'));
    assert.strictEqual(board.memory[0].key, 'proj/x');
    assert.strictEqual(board.unreadUser, 1);
  });

  await t.test('ジョブの権限確認が受信箱に出て、拒否を返せる', async () => {
    const j = await api('POST', '/api/jobs', { name: 'perm', cwd: home, prompt: 'PERM' });
    const p = await waitFor(async () => (await api('GET', '/api/permissions')).find((x) => x.sessionId === j.id), { label: 'permission' });
    assert.strictEqual(p.input.command, 'rm -rf build');
    await api('POST', `/api/permissions/${p.id}`, { behavior: 'deny' });
    const done = await finished(j.id);
    assert.match(JSON.parse(done.result)[0].perm, /"behavior":"deny"/);
  });

  await t.test('worktree で動いたジョブの差分を見て、worktree を片付ける', async () => {
    const repo = path.join(home, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'ignore' });
    g('init', '-q'); g('add', '.'); g('commit', '-qm', 'init');
    const j = await api('POST', '/api/jobs', { name: 'edit', cwd: repo, prompt: 'EDIT', worktree: true });
    const done = await finished(j.id);
    assert.strictEqual(done.worktreeInfo.branch, `galaxy/${j.id}`);
    assert.ok(!fs.existsSync(path.join(repo, 'edited-by-job.txt'))); // 元のリポジトリは触らない
    const d = await api('GET', `/api/diff?agent=${j.id}`);
    assert.deepStrictEqual(d.untracked, ['edited-by-job.txt']);
    await assert.rejects(api('POST', '/api/worktree/remove', { agent: j.id }), /変更があります/);
    await api('POST', '/api/worktree/remove', { agent: j.id, force: true });
    assert.strictEqual((await job(j.id)).worktreeInfo.removed, true);
  });

  await t.test('窓口: Claude で振り分けた案と、規則での案', async () => {
    fs.mkdirSync(path.join(home, 'projects', 'shop', '.git'), { recursive: true });
    const roots = [path.join(home, 'projects')];
    const a = await api('POST', '/api/dispatch/plan', { text: 'テストを調べて', roots });
    assert.strictEqual(a.router, 'claude');
    assert.strictEqual(a.mode, 'job');
    const b = await api('POST', '/api/dispatch/plan', { text: 'shop を直して', roots, useClaude: false });
    assert.strictEqual(b.router, 'heuristic');
    assert.strictEqual(path.basename(b.cwd), 'shop');
    const r = await api('POST', '/api/dispatch/run', { mode: 'job', cwd: home, name: 'from-dispatch', prompt: 'hello', permissionMode: 'plan' });
    assert.strictEqual(r.kind, 'job');
    await finished(r.job.id);
  });

  await t.test('監査ログに残る', async () => {
    const list = await waitFor(async () => { const l = await api('GET', '/api/audit'); return l.some((e) => e.kind === 'dispatch') && l; }, { label: 'audit' });
    const kinds = new Set(list.map((e) => e.kind));
    for (const k of ['session-start', 'job-start', 'job-end', 'tool', 'permission', 'dispatch', 'worktree-remove']) assert.ok(kinds.has(k), k);
    assert.ok(list.some((e) => e.kind === 'permission' && e.detail === '拒否'));
  });

  await t.test('ツール: Galaxy の MCP サーバーを登録して接続確認し、ジョブに渡す', async () => {
    const s = await api('POST', '/api/tools/servers', {
      name: 'bus-copy', type: 'stdio', command: process.execPath, args: path.join(ROOT, 'mcp-bus.js'), env: 'GALAXY_PORT=1\nGALAXY_TOKEN=x',
    });
    const c = await api('POST', `/api/tools/servers/${s.id}/check`);
    assert.ok(c.lastCheck.ok, c.lastCheck.error);
    assert.ok(c.lastCheck.tools.includes('memory_write'));
    const out = await api('POST', '/api/tools/claude-mcp-list', { cwd: home });
    assert.match(out.output, /fake-server/);
  });

  await t.test('再起動しても、セッションとジョブの記録が残る', async () => {
    await stop();
    await start();
    const sessions = await api('GET', '/api/sessions');
    assert.strictEqual(sessions[0].name, 'lead');
    assert.strictEqual(sessions[0].restored, true);
    assert.strictEqual(sessions[0].alive, false);
    const jobs = (await api('GET', '/api/jobs')).jobs;
    assert.ok(jobs.some((j) => j.name === 'parent' && j.status === 'done'));
    assert.strictEqual((await api('GET', '/api/board')).memory[0].key, 'proj/x');
  });
});
