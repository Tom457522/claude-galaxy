'use strict';
// フォルダ構造の走査とリレーション(親子 / import 依存)の抽出。
// グラフ画面(3D ビュー)用の API から使われる。読み取り専用で、ファイルの内容は返さない。

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const IS_WIN = process.platform === 'win32';
const norm = (p) => (IS_WIN || process.platform === 'darwin' ? p.toLowerCase() : p);

// 既定で除外するフォルダ(巨大・生成物・システム領域)
const DEFAULT_IGNORE = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.tox',
  '.next', '.nuxt', '.svelte-kit', 'dist', 'build', 'out', 'target', 'coverage', '.cache',
  '.turbo', '.gradle', '.idea', '.vscode', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'bower_components', '.parcel-cache', '.angular', '$recycle.bin', 'system volume information',
]);
// OS やツールが作る巨大領域。ホームフォルダ直下にあるときだけ除外する(プロジェクト内の同名フォルダは残す)
const HOME_ONLY_IGNORE = new Set([
  'appdata', 'library', '.trash', '.npm', '.nvm', '.cargo', '.rustup', '.docker', '.local', '.m2', 'applications',
]);
const HOME = require('os').homedir();

const CATEGORIES = {
  'JS/TS': ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'vue', 'svelte'],
  Python: ['py', 'pyi', 'ipynb'],
  Go: ['go'],
  Rust: ['rs'],
  'Java/Kotlin': ['java', 'kt', 'kts', 'scala'],
  'C/C++': ['c', 'h', 'cpp', 'cc', 'hpp', 'cxx'],
  'C#': ['cs'],
  'Ruby/PHP': ['rb', 'php'],
  Shell: ['sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd'],
  Web: ['html', 'htm', 'css', 'scss', 'sass', 'less'],
  Docs: ['md', 'mdx', 'txt', 'rst', 'pdf', 'docx', 'xlsx', 'pptx'],
  Config: ['json', 'yaml', 'yml', 'toml', 'ini', 'env', 'xml', 'lock'],
  Media: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'mp4', 'mov', 'mp3', 'wav'],
};
const EXT_TO_CAT = new Map();
for (const [cat, exts] of Object.entries(CATEGORIES)) for (const e of exts) EXT_TO_CAT.set(e, cat);

const JS_EXTS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'vue', 'svelte']);
const PY_EXTS = new Set(['py']);

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

function newNode(id, parent, depth) {
  return {
    id,
    name: path.basename(id) || id,
    parent: parent ? parent.id : null,
    depth,
    files: 0,
    dirs: 0,
    more: 0, // 深さ制限などで展開していないサブフォルダ数
    exts: {},
    cats: {},
    kind: 'folder',
  };
}

/**
 * root 以下を走査してノード/リンクを返す。
 * opts: maxDepth, hidden, includeIgnored, maxNodes, timeoutMs, imports
 */
async function scanFolder(root, opts = {}) {
  const {
    maxDepth = 3, hidden = false, includeIgnored = false, maxNodes = Infinity, timeoutMs = Infinity, imports = false,
  } = opts;
  const deadline = Date.now() + timeoutMs;
  const nodes = new Map();
  const idByNorm = new Map();
  const links = [];
  const codeFiles = [];
  let truncated = false;

  const add = (node) => { nodes.set(node.id, node); idByNorm.set(norm(node.id), node.id); };
  const rootNode = newNode(root, null, 0);
  rootNode.kind = 'root';
  add(rootNode);

  let level = [rootNode];
  while (level.length) {
    const next = [];
    await mapLimit(level, 24, async (node) => {
      if (Date.now() > deadline) { truncated = true; return; }
      let ents;
      try { ents = await fsp.readdir(node.id, { withFileTypes: true }); } catch (_) { node.unreadable = true; return; }
      for (const e of ents) {
        if (e.isDirectory()) {
          const name = e.name;
          if (!hidden && name.startsWith('.')) continue;
          if (!includeIgnored) {
            const low = name.toLowerCase();
            if (DEFAULT_IGNORE.has(low)) continue;
            if (HOME_ONLY_IGNORE.has(low) && norm(node.id) === norm(HOME)) continue;
          }
          node.dirs++;
          if (node.depth < maxDepth && nodes.size < maxNodes) {
            const child = newNode(path.join(node.id, name), node, node.depth + 1);
            add(child);
            links.push({ source: node.id, target: child.id, type: 'contains' });
            next.push(child);
          } else {
            if (node.depth < maxDepth) truncated = true;
            node.more++;
          }
        } else if (e.isFile()) { // シンボリックリンクは辿らない(循環・範囲外を避ける)
          node.files++;
          const dot = e.name.lastIndexOf('.');
          const ext = dot > 0 ? e.name.slice(dot + 1).toLowerCase() : '';
          if (ext) node.exts[ext] = (node.exts[ext] || 0) + 1;
          const cat = EXT_TO_CAT.get(ext) || 'Other';
          node.cats[cat] = (node.cats[cat] || 0) + 1;
          if (imports && (JS_EXTS.has(ext) || PY_EXTS.has(ext))) codeFiles.push({ file: path.join(node.id, e.name), ext, node });
        }
      }
    });
    level = next;
  }

  // 集計(深い階層から親へ)
  const all = [...nodes.values()].sort((a, b) => b.depth - a.depth);
  for (const n of all) {
    n.totalFiles = (n.totalFiles || 0) + n.files;
    n.allCats = n.allCats || {};
    for (const [c, k] of Object.entries(n.cats)) n.allCats[c] = (n.allCats[c] || 0) + k;
    const p = n.parent && nodes.get(n.parent);
    if (p) {
      p.totalFiles = (p.totalFiles || 0) + n.totalFiles;
      p.allCats = p.allCats || {};
      for (const [c, k] of Object.entries(n.allCats)) p.allCats[c] = (p.allCats[c] || 0) + k;
    }
  }

  // import 依存(フォルダ間)
  let importFilesRead = 0;
  if (imports && codeFiles.length) {
    const importDeadline = Infinity;
    const dirCache = new Map();
    const isDir = async (p) => {
      if (dirCache.has(p)) return dirCache.get(p);
      let r = false;
      try { r = (await fsp.stat(p)).isDirectory(); } catch (_) { r = false; }
      dirCache.set(p, r);
      return r;
    };
    const toNode = (dir) => {
      let d = dir;
      for (let i = 0; i < 64; i++) {
        const id = idByNorm.get(norm(d));
        if (id) return id;
        const up = path.dirname(d);
        if (up === d) return null;
        d = up;
      }
      return null;
    };
    const targetDir = async (t) => ((await isDir(t)) ? t : path.dirname(t));
    const edges = new Map();
    const addEdge = (from, toDir) => {
      const a = from.node.id;
      const b = toNode(toDir);
      if (!b || b === a) return;
      const k = `${a}\0${b}`;
      edges.set(k, (edges.get(k) || 0) + 1);
    };
    const JS_RE = /(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;
    const PY_RE = /^[ \t]*from[ \t]+(\.+)([\w.]*)[ \t]+import/gm;

    const list = codeFiles;
    await mapLimit(list, 32, async (cf) => {
      if (Date.now() > importDeadline) { truncated = true; return; }
      let text;
      try {
        const fh = await fsp.open(cf.file, 'r');
        try {
          const buf = Buffer.alloc(128 * 1024);
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          text = buf.toString('utf8', 0, bytesRead);
        } finally { await fh.close(); }
      } catch (_) { return; }
      importFilesRead++;
      const base = path.dirname(cf.file);
      if (JS_EXTS.has(cf.ext)) {
        // matchAll は呼び出しごとに正規表現を複製するので、並行処理中でも lastIndex が干渉しない
        const seen = new Set();
        for (const m of text.matchAll(JS_RE)) {
          const spec = m[1] || m[2] || m[3];
          if (!spec || !spec.startsWith('.') || seen.has(spec)) continue;
          seen.add(spec);
          addEdge(cf, await targetDir(path.resolve(base, spec)));
        }
      } else {
        for (const m of text.matchAll(PY_RE)) {
          let d = base;
          for (let i = 1; i < m[1].length; i++) d = path.dirname(d);
          const rest = m[2] ? path.join(d, ...m[2].split('.')) : d;
          addEdge(cf, m[2] ? await targetDir(rest) : rest);
        }
      }
    });
    for (const [k, w] of edges) {
      const [s, t] = k.split('\0');
      links.push({ source: s, target: t, type: 'import', weight: w });
    }
  }

  const out = [...nodes.values()].map((n) => {
    const cats = n.allCats || {};
    let cat = 'Other';
    let best = -1;
    for (const [c, k] of Object.entries(cats)) {
      if (c === 'Other') continue;
      if (k > best) { best = k; cat = c; }
    }
    const topExts = Object.entries(n.exts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e, k]) => [e, k]);
    return {
      id: n.id, name: n.name, parent: n.parent, depth: n.depth, kind: n.kind,
      files: n.files, totalFiles: n.totalFiles || 0, dirs: n.dirs, more: n.more,
      cat, cats, topExts, unreadable: !!n.unreadable,
    };
  });
  return { nodes: out, links, truncated, importFilesRead };
}

/**
 * 複数ルート(ホーム画面)または単一フォルダ(絞り込み表示)のグラフを作る。
 * 複数ルートのときは、仮想の HOME ノードを中心に各ルートをぶら下げる。
 */
async function buildGraph({ roots = [], focus = null, depth = 3, hidden = false, includeIgnored = false, imports = false }) {
  const t0 = Date.now();
  const errors = [];
  const check = async (p) => {
    const abs = path.resolve(String(p || '').trim().replace(/^"(.*)"$/, '$1'));
    try {
      if (!(await fsp.stat(abs)).isDirectory()) throw new Error('フォルダではありません');
      return abs;
    } catch (e) {
      errors.push({ path: abs, error: e.code === 'ENOENT' ? 'フォルダが見つかりません' : e.message });
      return null;
    }
  };
  const dep = Math.max(1, Math.min(8, Number(depth) || 3));

  if (focus) {
    const f = await check(focus);
    if (!f) return { nodes: [], links: [], truncated: false, errors, took: Date.now() - t0 };
    const r = await scanFolder(f, { maxDepth: dep, hidden, includeIgnored, imports });
    return { mode: 'focus', root: f, ...r, errors, took: Date.now() - t0 };
  }

  const valid = [];
  for (const r of roots.slice(0, 12)) {
    const a = await check(r);
    if (a && !valid.includes(a)) valid.push(a);
  }
  const nodes = [{ id: '__home__', name: 'HOME', parent: null, depth: -1, kind: 'hub', files: 0, totalFiles: 0, dirs: valid.length, more: 0, cat: 'Other', cats: {}, topExts: [] }];
  const links = [];
  let truncated = false;
  for (const r of valid) {
    const res = await scanFolder(r, { maxDepth: dep, hidden, includeIgnored, imports });
    for (const n of res.nodes) nodes.push(n);
    for (const l of res.links) links.push(l);
    links.push({ source: '__home__', target: r, type: 'root' });
    truncated = truncated || res.truncated;
  }
  return { mode: 'home', root: null, nodes, links, truncated, errors, took: Date.now() - t0 };
}

module.exports = { buildGraph, scanFolder, DEFAULT_IGNORE, CATEGORIES };
