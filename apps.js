'use strict';
// アプリ一覧(ランチャー)の保存と検証。保存先: ~/.claude-galaxy/apps.json
//   type 'web'     : URL(http/https)か、ローカルの HTML ファイル / フォルダ。アプリ内のタブ(iframe)で開く
//   type 'command' : 起動コマンド。ターミナルのセッションとして起動する

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const DATA_DIR = path.join(os.homedir(), '.claude-galaxy');
const FILE = path.join(DATA_DIR, 'apps.json');
const IS_WIN = process.platform === 'win32';

// 初回だけ入れておくアプリ
const DEFAULTS = [
  { name: 'Claude Code', icon: '✻', type: 'command', command: 'claude', cwd: '', desc: 'Claude Code CLI(作業フォルダを選んで起動)' },
  { name: IS_WIN ? 'PowerShell' : 'Shell', icon: '›_', type: 'command', command: IS_WIN ? 'powershell' : (process.env.SHELL || 'bash'), cwd: '', desc: '素のシェル' },
];

let apps = null;

function load() {
  if (apps) return apps;
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    apps = Array.isArray(data.apps) ? data.apps : [];
  } catch (_) {
    apps = DEFAULTS.map((a) => ({ id: newId(), ...a }));
    save();
  }
  return apps;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ apps }, null, 2));
  fs.renameSync(tmp, FILE);
}

const newId = () => `a${crypto.randomBytes(5).toString('hex')}`;
const isURL = (u) => /^https?:\/\//i.test(u);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function expandHome(p) {
  const s = p.trim().replace(/^"(.*)"$/, '$1');
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(1));
  return s;
}

// ローカル Web アプリの配信元(フォルダ)と最初に開くファイル
function localTarget(a) {
  const abs = path.resolve(expandHome(a.url));
  try {
    const st = fs.statSync(abs);
    if (st.isDirectory()) return { dir: abs, index: 'index.html' };
    if (st.isFile()) return { dir: path.dirname(abs), index: path.basename(abs) };
  } catch (_) { /* fallthrough */ }
  return null;
}

function validate(b) {
  const a = {
    name: str(b.name, 40),
    icon: str(b.icon, 4),
    type: b.type === 'web' ? 'web' : 'command',
    desc: str(b.desc, 120),
  };
  if (!a.name) throw new Error('名前を入力してください');
  if (a.type === 'web') {
    a.url = str(b.url, 2000);
    if (!a.url) throw new Error('URL またはファイルのパスを入力してください');
    if (!isURL(a.url)) {
      a.url = a.url.replace(/^"(.*)"$/, '$1');
      if (!localTarget(a)) throw new Error(`ファイル / フォルダが見つかりません: ${path.resolve(expandHome(a.url))}`);
    }
  } else {
    a.command = str(b.command, 1000);
    a.cwd = str(b.cwd, 1000).replace(/^"(.*)"$/, '$1');
    if (!a.command) throw new Error('起動コマンドを入力してください');
  }
  return a;
}

// 画面に渡す形(Web アプリは開く先 src を付ける)
function pub(a) {
  if (a.type !== 'web') return { ...a };
  if (isURL(a.url)) return { ...a, src: a.url, local: false };
  const t = localTarget(a);
  return { ...a, src: t ? `/appfiles/${a.id}/${encodeURIComponent(t.index)}` : '', local: true, missing: !t }; // src は APPS_PORT 側のパス
}

const list = () => load().map(pub);
const get = (id) => load().find((a) => a.id === id) || null;

function create(b) {
  const a = { id: newId(), ...validate(b) };
  load().push(a);
  save();
  return pub(a);
}

function update(id, b) {
  const i = load().findIndex((a) => a.id === id);
  if (i < 0) return null;
  apps[i] = { id, ...validate(b) };
  save();
  statics.delete(id);
  return pub(apps[i]);
}

function remove(id) {
  const i = load().findIndex((a) => a.id === id);
  if (i < 0) return false;
  apps.splice(i, 1);
  save();
  statics.delete(id);
  return true;
}

// ローカル Web アプリ用の静的配信(アプリごとにキャッシュ。ドットファイルは配信しない)
const statics = new Map();
function staticHandler(id) {
  const a = get(id);
  if (!a || a.type !== 'web' || isURL(a.url)) return null;
  const t = localTarget(a);
  if (!t) return null;
  const key = `${t.dir}|${t.index}`;
  const c = statics.get(id);
  if (c && c.key === key) return c.fn;
  const fn = express.static(t.dir, { index: [t.index], dotfiles: 'ignore', fallthrough: false });
  statics.set(id, { key, fn });
  return fn;
}

module.exports = { list, get, create, update, remove, staticHandler, FILE };
