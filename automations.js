'use strict';
// オートメーション: きっかけがあったらジョブを登録する。保存先: ~/.claude-galaxy/automations.json
//   kind 'cron'  : cron 式の時刻に(ローカル時刻。サーバーが止まっていた間の分は実行しない)
//   kind 'files' : フォルダ内のファイルが変わったら(まとめて debounce 秒後に 1 回)
//   kind 'git'   : リポジトリに新しいコミットができたら(HEAD を定期的に確認)
//   kind 'after' : 別のオートメーションのジョブが終わったら(ジョブのつなぎ。{{prevResult}} などで結果を渡せる)
// プロンプトでは {{date}} {{time}} {{files}} {{commit}} {{commitMessage}} {{automation}}
// {{prevJob}} {{prevStatus}} {{prevResult}} {{prevCwd}} が使える

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const cron = require('./cron');
const { DATA_DIR } = require('./store');

const FILE = path.join(DATA_DIR, 'automations.json');
const KINDS = ['cron', 'files', 'git', 'after'];
const MAX_CHAIN = 10; // つなぎの深さの上限(輪になっても止まるように)
const IGNORE_DIRS = /(^|[\\/])(node_modules|\.git|\.claude-galaxy|dist|build|\.next|\.cache|__pycache__|\.venv)([\\/]|$)/;
const GIT_POLL_MS = 15000;
const AFTER_RUN_GRACE_MS = 5000; // 自分のジョブが書き換えたファイルで再び動かないよう、終了直後は無視する

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function createAutomations(deps) {
  // deps: resolveCwd(p), submit(template, meta) -> job, isActive(jobId), onChange(info), onRemove(id)
  let list = [];
  const rt = new Map(); // id -> { watcher, timer, files:Set, gitTimer, lastHead, error, cron }

  function load() {
    try { list = JSON.parse(fs.readFileSync(FILE, 'utf8')).automations || []; } catch (_) { list = []; }
    list = list.filter((a) => a && /^a[0-9a-f]+$/.test(a.id));
  }
  function save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ automations: list }, null, 2));
      fs.renameSync(tmp, FILE);
    } catch (e) { console.error('automations.json を保存できません:', e.message); }
  }

  const info = (a) => {
    const r = rt.get(a.id) || {};
    let nextRun = null;
    if (a.kind === 'cron' && a.enabled && r.cron) nextRun = cron.next(r.cron)?.getTime() || null;
    return { ...a, error: r.error || '', nextRun, pendingFiles: r.files ? r.files.size : 0 };
  };
  const notify = (a) => deps.onChange(info(a));

  function validate(input, prev = {}) {
    const kind = KINDS.includes(input.kind) ? input.kind : (prev.kind || 'cron');
    const a = {
      id: prev.id || `a${crypto.randomBytes(4).toString('hex')}`,
      name: str(input.name, 80) || prev.name || '名前なし',
      enabled: input.enabled === undefined ? (prev.enabled ?? true) : !!input.enabled,
      kind,
      cron: kind === 'cron' ? str(input.cron, 100) : '',
      watchPath: kind === 'files' || kind === 'git' ? str(input.watchPath, 1000) : '',
      afterAutomationId: kind === 'after' ? str(input.afterAutomationId, 40) : '',
      afterStatus: kind === 'after' && input.afterStatus === 'any' ? 'any' : 'done',
      debounceSec: Math.min(3600, Math.max(2, Number(input.debounceSec) || prev.debounceSec || 10)),
      skipIfRunning: input.skipIfRunning === undefined ? (prev.skipIfRunning ?? true) : !!input.skipIfRunning,
      template: input.template && typeof input.template === 'object' ? input.template : (prev.template || {}),
      createdAt: prev.createdAt || Date.now(),
      lastFiredAt: prev.lastFiredAt || null,
      lastJobId: prev.lastJobId || null,
      lastSkipped: prev.lastSkipped || null,
    };
    if (!str(a.template.prompt, 100000)) throw new Error('プロンプトを入力してください');
    if (kind === 'cron') cron.parse(a.cron);
    else if (kind === 'after') {
      if (!a.afterAutomationId) throw new Error('どのオートメーションのあとに動かすかを選んでください');
      if (a.afterAutomationId === a.id) throw new Error('自分自身のあとには動かせません');
      if (!list.some((x) => x.id === a.afterAutomationId)) throw new Error('あとに続ける元のオートメーションが見つかりません');
    } else a.watchPath = deps.resolveCwd(a.watchPath);
    if (kind === 'git' && !fs.existsSync(path.join(a.watchPath, '.git'))) {
      throw new Error(`git リポジトリではありません(.git がありません): ${a.watchPath}`);
    }
    return a;
  }

  function fill(text, vars) {
    return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  }

  // ジョブを登録する。manual: 「今すぐ実行」
  function fire(a, vars = {}, { manual = false, chainDepth = 0 } = {}) {
    const r = rt.get(a.id) || {};
    if (!manual && a.skipIfRunning && a.lastJobId && deps.isActive(a.lastJobId)) {
      a.lastSkipped = Date.now();
      save();
      notify(a);
      return null;
    }
    const now = new Date();
    const all = {
      date: now.toLocaleDateString(), time: now.toLocaleTimeString(), automation: a.name, files: '', commit: '', commitMessage: '',
      prevJob: '', prevStatus: '', prevResult: '', prevCwd: '', ...vars,
    };
    const t = a.template;
    try {
      const job = deps.submit({
        ...t,
        name: t.name || a.name,
        prompt: fill(String(t.prompt || ''), all),
        cwd: t.cwd || (a.kind === 'after' ? all.prevCwd : a.kind !== 'cron' ? a.watchPath : ''),
      }, { source: 'automation', automationId: a.id, chainDepth });
      a.lastFiredAt = Date.now();
      a.lastJobId = job.id;
      r.error = '';
      save();
      notify(a);
      return job;
    } catch (e) {
      r.error = e.message;
      notify(a);
      if (manual) throw e;
      return null;
    }
  }

  // ---- 監視の開始 / 停止 ----
  function stop(id) {
    const r = rt.get(id);
    if (!r) return;
    if (r.watcher) { try { r.watcher.close(); } catch (_) { /* ignore */ } }
    clearTimeout(r.timer);
    clearInterval(r.gitTimer);
    rt.delete(id);
  }

  function arm(a) {
    stop(a.id);
    const r = { files: new Set(), error: '' };
    rt.set(a.id, r);
    if (!a.enabled) return;
    try {
      if (a.kind === 'cron') {
        r.cron = cron.parse(a.cron);
      } else if (a.kind === 'files') {
        r.watcher = fs.watch(a.watchPath, { recursive: true }, (_ev, name) => onFile(a, r, name ? String(name) : ''));
        r.watcher.on('error', (e) => { r.error = `監視エラー: ${e.message}`; notify(a); });
      } else if (a.kind === 'git') {
        gitHead(a.watchPath).then((h) => { r.lastHead = h; });
        r.gitTimer = setInterval(() => checkGit(a, r), GIT_POLL_MS);
        r.gitTimer.unref();
      }
    } catch (e) {
      r.error = `監視を開始できません: ${e.message}`;
    }
  }

  function recentlyRan(a) {
    if (!a.lastJobId) return false;
    if (deps.isActive(a.lastJobId)) return true;
    const end = deps.jobEndedAt(a.lastJobId);
    return !!end && Date.now() - end < AFTER_RUN_GRACE_MS;
  }

  function onFile(a, r, name) {
    if (!name || IGNORE_DIRS.test(name) || /(~|\.swp|\.tmp)$/.test(name)) return;
    if (recentlyRan(a)) return; // 自分のジョブの書き換えは数えない
    r.files.add(name);
    clearTimeout(r.timer);
    r.timer = setTimeout(() => {
      const files = [...r.files];
      r.files.clear();
      if (!files.length) return;
      const shown = files.slice(0, 50).join('\n') + (files.length > 50 ? `\n…ほか ${files.length - 50} 件` : '');
      fire(a, { files: shown });
    }, a.debounceSec * 1000);
    notify(a);
  }

  function gitHead(dir) {
    return new Promise((resolve) => {
      execFile('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeout: 10000 }, (err, out) => resolve(err ? null : out.trim()));
    });
  }

  async function checkGit(a, r) {
    const h = await gitHead(a.watchPath);
    if (!h || h === r.lastHead) return;
    const first = r.lastHead === undefined || r.lastHead === null;
    r.lastHead = h;
    if (first) return;
    const msg = await new Promise((resolve) => {
      execFile('git', ['-C', a.watchPath, 'log', '-1', '--format=%s'], { timeout: 10000 }, (err, out) => resolve(err ? '' : out.trim()));
    });
    fire(a, { commit: h, commitMessage: msg });
  }

  // cron は 20 秒ごとに確認し、同じ分には 1 回だけ実行する
  let lastMinute = '';
  setInterval(() => {
    const d = new Date();
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
    if (key === lastMinute) return;
    lastMinute = key;
    for (const a of list) {
      const r = rt.get(a.id);
      if (a.enabled && a.kind === 'cron' && r && r.cron && cron.matches(r.cron, d)) fire(a);
    }
  }, 20000).unref();

  // ジョブが終わったら、「このあとに動かす」オートメーションを登録する
  function onJobFinished(job) {
    if (!job.automationId || job.status === 'canceled') return;
    if ((job.chainDepth || 0) >= MAX_CHAIN) return;
    for (const a of list) {
      if (!a.enabled || a.kind !== 'after' || a.afterAutomationId !== job.automationId) continue;
      if (a.afterStatus === 'done' && job.status !== 'done') continue;
      fire(a, {
        prevJob: `${job.id} ${job.name}`,
        prevStatus: job.status,
        prevResult: String(job.result || job.error || '').slice(0, 8000),
        prevCwd: job.cwd,
      }, { chainDepth: (job.chainDepth || 0) + 1 });
    }
  }

  load();
  for (const a of list) arm(a);

  return {
    list: () => list.map(info),
    create(input) {
      const a = validate(input);
      list.push(a);
      save();
      arm(a);
      notify(a);
      return info(a);
    },
    update(id, input) {
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) return null;
      const a = validate({ ...list[i], ...input }, list[i]);
      list[i] = a;
      save();
      arm(a);
      notify(a);
      return info(a);
    },
    remove(id) {
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) return false;
      stop(id);
      list.splice(i, 1);
      save();
      deps.onRemove(id);
      return true;
    },
    onJobFinished,
    run(id) {
      const a = list.find((x) => x.id === id);
      if (!a) throw new Error('見つかりません');
      return fire(a, {}, { manual: true });
    },
  };
}

module.exports = { createAutomations };
