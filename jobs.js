'use strict';
// ジョブキュー: Claude Code をヘッドレス(claude -p)で実行する。
//   - 優先度(high / normal / low)→ 登録順に、同時実行数の上限まで起動する
//   - 出力は stream-json で受け、進み具合(最後のテキスト・ツール)と結果・コストを記録する
//   - 保存先: ~/.claude-galaxy/jobs.json と ~/.claude-galaxy/jobs/<id>.jsonl(生の出力)

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { DATA_DIR } = require('./store');

const FILE = path.join(DATA_DIR, 'jobs.json');
const LOG_DIR = path.join(DATA_DIR, 'jobs');
const KEEP_FINISHED = 300;
const IS_WIN = process.platform === 'win32';

const PRIORITY = { high: 0, normal: 1, low: 2 };
// -p では確認ダイアログを出せないので、許可が要る操作は受信箱で答える(答えなければ拒否)
const PERMISSION_MODES = ['', 'plan', 'dontAsk', 'acceptEdits', 'auto', 'bypassPermissions'];
const ACTIVE = new Set(['queued', 'running']);

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const logPath = (id) => path.join(LOG_DIR, `${id}.jsonl`);

// 引数に埋め込む値の検査(シェル経由で起動するため、記号を含むものは受け付けない)
const SAFE_MODEL = /^[A-Za-z0-9._:[\]-]{1,80}$/;
const SAFE_TOOL = /^[A-Za-z0-9_*:.()/@ -]{1,200}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{8,100}$/;

function normalize(input, { strict = false } = {}) {
  const prompt = str(input.prompt, 100000);
  if (!prompt) throw new Error('プロンプトを入力してください');
  const model = str(input.model, 80);
  if (model && !SAFE_MODEL.test(model)) throw new Error(`モデル名が不正です: ${model}`);
  const permissionMode = str(input.permissionMode, 40);
  if (!PERMISSION_MODES.includes(permissionMode)) throw new Error(`権限モードが不正です: ${permissionMode}`);
  const allowedTools = (Array.isArray(input.allowedTools) ? input.allowedTools : String(input.allowedTools || '').split(/[\n,]/))
    .map((t) => String(t).trim()).filter(Boolean).slice(0, 50);
  for (const t of allowedTools) if (!SAFE_TOOL.test(t)) throw new Error(`許可ツールの指定が不正です: ${t}`);
  const budget = input.maxBudgetUsd === '' || input.maxBudgetUsd == null ? null : Number(input.maxBudgetUsd);
  if (budget !== null && !(budget > 0 && budget <= 1000)) throw new Error('予算(USD)は 0 より大きい数で指定してください');
  const priority = PRIORITY[input.priority] !== undefined ? input.priority : 'normal';
  const resumeId = str(input.resumeId, 100);
  if (resumeId && !SAFE_ID.test(resumeId)) throw new Error('再開するセッション ID が不正です');
  if (strict && (permissionMode === 'bypassPermissions' || permissionMode === 'auto' || allowedTools.length)) {
    throw new Error('エージェントから登録するジョブでは、bypassPermissions / auto と許可ツールの指定は使えません');
  }
  return {
    name: str(input.name, 80) || prompt.split('\n')[0].slice(0, 40),
    prompt,
    cwd: str(input.cwd, 1000),
    model,
    permissionMode,
    allowedTools,
    maxBudgetUsd: budget,
    priority,
    resumeId,
    worktree: !!input.worktree, // 別の git worktree(ブランチ)で実行する
    memory: str(input.memory, 500), // 共有メモリから最初に渡すもの(キーの先頭・タグ・語。空白区切り)
    mcpServers: Array.isArray(input.mcpServers) ? input.mcpServers.filter((x) => typeof x === 'string').slice(0, 30) : null,
  };
}

function createJobManager(deps) {
  // deps: resolveCwd(cwd), checkCommand(cmd, cwd), buildCommand(job) -> cmdline, envFor(job), shell,
  //       onChange(publicJob), onRemove(id), getMaxConcurrent(), onFinish(job)
  const jobs = new Map();
  let seq = 0;
  let saveTimer = null;

  const publicJob = (j) => ({
    id: j.id,
    name: j.name,
    prompt: j.prompt,
    cwd: j.cwd,
    model: j.model,
    permissionMode: j.permissionMode,
    allowedTools: j.allowedTools,
    maxBudgetUsd: j.maxBudgetUsd,
    priority: j.priority,
    resumeId: j.resumeId,
    worktree: j.worktree,
    worktreeInfo: j.worktreeInfo || null,
    mcpServers: j.mcpServers,
    status: j.status,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    source: j.source,
    parent: j.parent,
    automationId: j.automationId,
    depth: j.depth || 0,
    claudeSessionId: j.claudeSessionId,
    lastText: j.lastText,
    lastTool: j.lastTool,
    blockedBy: j.blockedBy || '',
    memory: j.memory || '',
    chainDepth: j.chainDepth || 0,
    result: j.result,
    isError: j.isError,
    error: j.error,
    costUsd: j.costUsd,
    usage: j.usage,
    numTurns: j.numTurns,
    durationMs: j.durationMs,
  });

  const persistRecord = (j) => { const { proc, notifyTimer, waiters, ...rest } = j; return rest; };

  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 500);
    saveTimer.unref();
  }
  function saveNow() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ jobs: [...jobs.values()].map(persistRecord) }, null, 2));
      fs.renameSync(tmp, FILE);
    } catch (e) { console.error('jobs.json を保存できません:', e.message); }
  }

  // 進み具合の通知は間引く(ストリーム出力ごとに送らない)
  function changed(j, { now = false } = {}) {
    save();
    if (now) {
      clearTimeout(j.notifyTimer);
      j.notifyTimer = null;
      deps.onChange(publicJob(j));
      return;
    }
    if (j.notifyTimer) return;
    j.notifyTimer = setTimeout(() => { j.notifyTimer = null; deps.onChange(publicJob(j)); }, 400);
  }

  function settle(j) {
    for (const w of j.waiters) w(publicJob(j));
    j.waiters = [];
  }

  function load() {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(FILE, 'utf8')).jobs || []; } catch (_) { /* 初回 */ }
    for (const r of list) {
      if (!r || !/^j\d+$/.test(r.id)) continue;
      const j = { ...r, proc: null, notifyTimer: null, waiters: [] };
      if (j.status === 'running') {
        j.status = 'failed';
        j.error = 'サーバーの再起動で中断しました';
        j.endedAt = j.endedAt || Date.now();
      }
      jobs.set(j.id, j);
      seq = Math.max(seq, Number(j.id.slice(1)) || 0);
    }
    trim();
  }

  // 終わったジョブは新しいものから KEEP_FINISHED 件だけ残す
  function trim() {
    const done = [...jobs.values()].filter((j) => !ACTIVE.has(j.status)).sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
    for (const j of done.slice(KEEP_FINISHED)) {
      jobs.delete(j.id);
      try { fs.unlinkSync(logPath(j.id)); } catch (_) { /* ignore */ }
    }
  }

  function create(input, meta = {}) {
    const spec = normalize(input, { strict: !!meta.strict });
    const cwd = deps.resolveCwd(spec.cwd || meta.defaultCwd);
    const j = {
      id: `j${++seq}`,
      ...spec,
      cwd,
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      source: meta.source || 'ui', // ui / agent / automation
      parent: meta.parent || null, // 登録したエージェント(セッション / ジョブの ID)
      automationId: meta.automationId || null,
      depth: meta.depth || 0, // エージェントがジョブを登録した深さ(暴走防止)
      chainDepth: meta.chainDepth || 0, // オートメーションの「ジョブのあとに」でつながった深さ
      claudeSessionId: null,
      lastText: '',
      lastTool: '',
      result: '',
      isError: false,
      error: '',
      costUsd: 0,
      usage: null,
      numTurns: 0,
      durationMs: 0,
      stderr: '',
      proc: null,
      notifyTimer: null,
      waiters: [],
    };
    jobs.set(j.id, j);
    changed(j, { now: true });
    pump();
    return publicJob(j);
  }

  const running = () => [...jobs.values()].filter((j) => j.status === 'running').length;

  function pump() {
    // 予算の上限に達していたら起動しない(待ちのジョブに理由を表示する)
    const blocked = deps.blockReason ? deps.blockReason() : '';
    for (const j of jobs.values()) {
      if (j.status !== 'queued') continue;
      const note = blocked || '';
      if ((j.blockedBy || '') !== note) { j.blockedBy = note; changed(j); }
    }
    if (blocked) return;
    const max = Math.max(1, deps.getMaxConcurrent());
    while (running() < max) {
      const next = [...jobs.values()].filter((j) => j.status === 'queued')
        .sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.createdAt - b.createdAt)[0];
      if (!next) return;
      start(next);
    }
  }

  function finish(j, status, error) {
    if (!ACTIVE.has(j.status)) return;
    j.status = status;
    if (error) j.error = error;
    j.endedAt = Date.now();
    j.proc = null;
    changed(j, { now: true });
    settle(j);
    deps.onFinish(publicJob(j));
    trim();
    setImmediate(pump);
  }

  function handleLine(j, line) {
    let m;
    try { m = JSON.parse(line); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.session_id && SAFE_ID.test(m.session_id)) j.claudeSessionId = m.session_id;
    if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (b.type === 'text' && b.text && b.text.trim()) j.lastText = clip(b.text.trim(), 400);
        if (b.type === 'tool_use') {
          j.lastTool = clip(b.name, 80);
          if (deps.onToolUse) deps.onToolUse(publicJob(j), b.name, b.input);
        }
      }
      changed(j);
    } else if (m.type === 'result') {
      j.result = clip(typeof m.result === 'string' ? m.result : '', 20000);
      j.isError = !!m.is_error || (typeof m.subtype === 'string' && m.subtype !== 'success');
      if (j.isError && !j.result) j.error = clip(m.subtype || 'エラー', 200);
      if (Number.isFinite(m.total_cost_usd)) j.costUsd = m.total_cost_usd;
      if (m.usage && typeof m.usage === 'object') {
        j.usage = {
          input: m.usage.input_tokens || 0,
          output: m.usage.output_tokens || 0,
          cacheWrite: m.usage.cache_creation_input_tokens || 0,
          cacheRead: m.usage.cache_read_input_tokens || 0,
        };
      }
      j.numTurns = m.num_turns || 0;
      j.durationMs = m.duration_ms || 0;
      changed(j, { now: true });
    }
  }

  function start(j) {
    let cmdline;
    try {
      if (deps.prepare) deps.prepare(j); // worktree の作成など(cwd が変わることがある)
      deps.checkCommand(deps.jobCommand(), j.cwd);
      cmdline = deps.buildCommand(j);
    } catch (e) {
      j.status = 'running'; // finish() は実行中のものだけを閉じる
      finish(j, 'failed', e.message);
      return;
    }
    j.status = 'running';
    j.startedAt = Date.now();
    j.lastText = '';
    j.lastTool = '';
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const log = fs.createWriteStream(logPath(j.id), { flags: 'w' });
    log.on('error', () => { /* ignore */ });

    // Windows: cmd.exe /c(claude.cmd を PATHEXT で解決)/ Unix: ログインシェル経由で PATH を引き継ぐ
    const proc = IS_WIN
      ? spawn(deps.shell, ['/d', '/s', '/c', `"${cmdline}"`], { cwd: j.cwd, env: deps.envFor(j), windowsVerbatimArguments: true, windowsHide: true })
      : spawn(deps.shell, ['-l', '-c', `exec ${cmdline}`], { cwd: j.cwd, env: deps.envFor(j) });
    j.proc = proc;
    changed(j, { now: true });

    let rest = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      log.write(chunk);
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines) if (line.trim()) handleLine(j, line);
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => { j.stderr = (j.stderr + chunk).slice(-4000); });
    proc.on('error', (e) => finish(j, 'failed', `起動できません: ${e.message}`));
    proc.on('close', (code) => {
      if (rest.trim()) handleLine(j, rest);
      log.end();
      if (j.status !== 'running') return; // 中止済み
      const ok = code === 0 && !j.isError && (j.result || j.claudeSessionId);
      finish(j, ok ? 'done' : 'failed', ok ? '' : (j.error || clip(j.stderr.trim(), 600) || `終了コード ${code}`));
    });
    // プロンプトは標準入力で渡す(引数のクォートを気にしなくてよい)
    proc.stdin.on('error', () => { /* ignore */ });
    proc.stdin.end(j.prompt);
  }

  function kill(proc) {
    if (!proc || proc.exitCode !== null) return;
    if (IS_WIN) {
      // cmd.exe の子(claude)ごと止める
      execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => {});
    } else {
      try { proc.kill('SIGTERM'); } catch (_) { /* ignore */ }
      setTimeout(() => { try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch (_) { /* ignore */ } }, 5000).unref();
    }
  }

  function cancel(id) {
    const j = jobs.get(id);
    if (!j || !ACTIVE.has(j.status)) return false;
    const proc = j.proc;
    finish(j, 'canceled', '中止しました');
    kill(proc);
    return true;
  }

  function retry(id) {
    const j = jobs.get(id);
    if (!j) throw new Error('ジョブが見つかりません');
    // worktree で動いたジョブは、元の作業ディレクトリで新しい worktree を作り直す
    const src = j.worktreeInfo ? { ...j, cwd: j.worktreeInfo.origCwd || j.cwd } : j;
    return create(src, { source: j.source, parent: j.parent, automationId: j.automationId, depth: j.depth });
  }

  // 記録の一部を書き換える(worktree を片付けたときなど)
  function patch(id, fields) {
    const j = jobs.get(id);
    if (!j) return null;
    Object.assign(j, fields);
    changed(j, { now: true });
    return publicJob(j);
  }

  function remove(id) {
    const j = jobs.get(id);
    if (!j) return false;
    if (ACTIVE.has(j.status)) cancel(id);
    jobs.delete(id);
    try { fs.unlinkSync(logPath(id)); } catch (_) { /* ignore */ }
    save();
    deps.onRemove(id);
    return true;
  }

  // 終わるまで待つ(最大 timeoutMs)。終わっていればすぐ返す
  function wait(id, timeoutMs) {
    const j = jobs.get(id);
    if (!j) return Promise.resolve(null);
    if (!ACTIVE.has(j.status) || timeoutMs <= 0) return Promise.resolve(publicJob(j));
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        j.waiters = j.waiters.filter((w) => w !== done);
        resolve(publicJob(j));
      }, timeoutMs);
      const done = (pj) => { clearTimeout(t); resolve(pj); };
      j.waiters.push(done);
    });
  }

  // 生の出力から、読みやすい経過(テキスト・ツール呼び出し・結果)を作る
  function transcript(id) {
    let text = '';
    try {
      const st = fs.statSync(logPath(id));
      const len = Math.min(st.size, 4 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(logPath(id), 'r');
      try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
      text = buf.toString('utf8');
    } catch (_) { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      let m;
      try { m = JSON.parse(line); } catch (_) { continue; }
      if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
        for (const b of m.message.content) {
          if (b.type === 'text' && b.text && b.text.trim()) out.push({ kind: 'text', text: clip(b.text, 8000) });
          if (b.type === 'tool_use') {
            const inp = b.input || {};
            const hint = inp.command || inp.file_path || inp.pattern || inp.url || inp.description || '';
            out.push({ kind: 'tool', text: `${b.name}${hint ? `  ${clip(String(hint), 300)}` : ''}` });
          }
        }
      } else if (m.type === 'result') {
        out.push({ kind: 'result', text: clip(m.result || m.subtype || '', 8000), error: !!m.is_error });
      }
    }
    return out.slice(-400);
  }

  function shutdown() {
    for (const j of jobs.values()) {
      if (j.status === 'running') {
        j.status = 'failed';
        j.error = 'サーバーの停止で中断しました';
        j.endedAt = Date.now();
        kill(j.proc);
      }
    }
    clearTimeout(saveTimer);
    saveNow();
  }

  load();
  return {
    list: () => [...jobs.values()].map(publicJob),
    get: (id) => (jobs.has(id) ? publicJob(jobs.get(id)) : null),
    isRunning: (id) => jobs.get(id)?.status === 'running',
    create,
    patch,
    cancel,
    retry,
    remove,
    wait,
    pump,
    transcript,
    shutdown,
  };
}

module.exports = { createJobManager, normalize, PERMISSION_MODES };
