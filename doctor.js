'use strict';
// 自己診断: このアプリが動くための前提を順に確かめる。
//   claude と node が見つかるか / hook が本体に届くか / 共有バスの MCP がつながるか / git があるか / 保存先に書けるか など

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const IS_WIN = process.platform === 'win32';

function run(cmd, args, { input = '', env, timeout = 20000, cwd } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const p = spawn(cmd, args, { env, cwd, windowsHide: true });
    const finish = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => { try { p.kill(); } catch (_) { /* ignore */ } finish({ code: null, out, err, timeout: true }); }, timeout);
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', (e) => finish({ code: null, out, err: e.message }));
    p.on('close', (code) => finish({ code, out, err }));
    p.stdin.on('error', () => { /* ignore */ });
    p.stdin.end(input);
  });
}

// deps: shell, jobCommand, checkCommand(cmd, cwd), runClaude(args, opts), hookPath, mcpPath, port,
//       diagToken(), waitDiagHook(ms) -> Promise<bool>, dataDir, tmpDir, settingsFile
async function diagnose(deps) {
  const results = [];
  const add = (id, label, status, detail, hint = '') => results.push({ id, label, status, detail, hint });

  // 1. Node.js
  const major = Number(process.versions.node.split('.')[0]);
  add('node', 'Node.js', major >= 18 ? 'ok' : 'fail', `v${process.versions.node}`, major >= 18 ? '' : 'Node.js 18 以上に更新してください');

  // 2. claude コマンド
  let claudeOk = false;
  try {
    deps.checkCommand(deps.jobCommand, os.homedir());
    const r = await deps.runClaude('--version', { cwd: os.homedir(), timeoutMs: 30000 });
    claudeOk = r.code === 0;
    add('claude', 'claude コマンド', claudeOk ? 'ok' : 'fail', `${deps.jobCommand}: ${(r.out || r.err).trim().split('\n')[0] || `終了コード ${r.code}`}`,
      claudeOk ? '' : 'claude を単体で起動できるか、ターミナルで確かめてください');
  } catch (e) {
    add('claude', 'claude コマンド', 'fail', e.message.split('\n')[0], e.message.split('\n').slice(1).join(' '));
  }

  // 3. hook を動かす node が、起動に使うシェルから見えるか
  {
    const r = IS_WIN
      ? await run('where.exe', ['node'])
      : await run(deps.shell, ['-l', '-c', 'command -v node']);
    const found = r.code === 0 && r.out.trim();
    add('hook-node', 'hook 用の node', found ? 'ok' : 'fail', found ? r.out.trim().split('\n')[0] : '見つかりません',
      found ? '' : 'hook は node コマンドで動きます。ログインシェル(Windows は PATH)から node が見えるようにしてください');
  }

  // 4. hook が本体に届くか(診断用のトークンで hook.js を実際に動かす)
  {
    const env = { ...process.env, GALAXY_SESSION: 'diag', GALAXY_PORT: String(deps.port), GALAXY_TOKEN: deps.diagToken() };
    const wait = deps.waitDiagHook(8000);
    await run(process.execPath, [deps.hookPath, 'Notification'], { env, input: JSON.stringify({ hook_event_name: 'Notification', message: 'diag' }) });
    const ok = await wait;
    add('hook', 'hook → 本体への通知', ok ? 'ok' : 'fail', ok ? 'hook.js からの通知を受け取りました' : '通知が届きませんでした',
      ok ? '' : 'ファイアウォールやセキュリティソフトが 127.0.0.1 への接続を止めていないか確認してください');
  }

  // 5. 共有バスの MCP サーバー
  {
    const env = { ...process.env, GALAXY_SESSION: 'diag', GALAXY_PORT: String(deps.port), GALAXY_TOKEN: deps.diagToken() };
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'diag', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ].map((m) => JSON.stringify(m)).join('\n');
    // 標準入力を閉じると終わるので、応答が出そろうまで少し待ってから閉じる
    const r = await new Promise((resolve) => {
      const p = spawn(process.execPath, [deps.mcpPath], { env, windowsHide: true });
      let out = '';
      p.stdout.on('data', (c) => { out += c; if (/"id":2/.test(out)) p.stdin.end(); });
      p.on('close', () => resolve(out));
      p.on('error', () => resolve(out));
      p.stdin.write(`${input}\n`);
      setTimeout(() => { try { p.stdin.end(); } catch (_) { /* ignore */ } }, 8000);
    });
    let tools = 0;
    for (const line of r.split('\n')) {
      try { const m = JSON.parse(line); if (m.id === 2 && m.result) tools = m.result.tools.length; } catch (_) { /* ignore */ }
    }
    add('mcp', '共有バス(MCP サーバー)', tools ? 'ok' : 'fail', tools ? `ツール ${tools} 個` : '応答がありません');
  }

  // 6. git
  try {
    const v = execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
    add('git', 'git', 'ok', v);
  } catch (_) {
    add('git', 'git', 'warn', '見つかりません', '差分表示と worktree には git が必要です');
  }

  // 7. 保存先に書けるか
  for (const [id, label, dir] of [['data', '保存先', deps.dataDir], ['tmp', '一時フォルダ', deps.tmpDir]]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `.diag-${process.pid}`);
      fs.writeFileSync(f, 'ok');
      fs.unlinkSync(f);
      add(id, label, 'ok', dir);
    } catch (e) {
      add(id, label, 'fail', `${dir}: ${e.message}`);
    }
  }

  // 8. 利用者自身の hooks(このアプリの hooks と併用されるかは未確認なので注意を出す)
  {
    const file = path.join(os.homedir(), '.claude', 'settings.json');
    let has = false;
    try { has = !!(JSON.parse(fs.readFileSync(file, 'utf8')).hooks); } catch (_) { has = false; }
    add('user-hooks', 'あなた自身の hooks', has ? 'warn' : 'ok', has ? `${file} に hooks があります` : 'なし',
      has ? 'このアプリの hooks と併用されるかは確認できていません。状態表示や受信箱がおかしいときは、一時的に外して試してください' : '');
  }

  return { at: Date.now(), ok: results.every((r) => r.status !== 'fail'), results, claudeOk };
}

module.exports = { diagnose };
