'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempHome } = require('./helpers');

const home = tempHome();
const { createTools, claudeMcpServers, claudeExtensions } = require('../tools');

// 最小の MCP サーバー(initialize と tools/list だけ答える)
const SERVER = path.join(home, 'mini-mcp.js');
fs.writeFileSync(SERVER, `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { serverInfo: { name: 'mini' }, capabilities: {} } }));
  if (m.method === 'tools/list') console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'hello' }, { name: 'world' }] } }));
});`);

test('登録・伏せ字・既定で使うもの・接続確認', async () => {
  const t = createTools();
  const s = t.create({ name: 'mini', type: 'stdio', command: process.execPath, args: SERVER, env: 'TOKEN=abc', defaultOn: true });
  assert.deepStrictEqual(s.env, { TOKEN: '••••' }); // 画面には値を出さない
  t.create({ name: 'web', type: 'http', url: 'https://example.com/mcp', headers: 'Authorization: Bearer x' });
  assert.deepStrictEqual(Object.keys(t.configFor(null)), ['mini']);
  assert.strictEqual(t.configFor(null).mini.env.TOKEN, 'abc');
  // 伏せ字のまま更新しても、元の値が残る
  t.update(s.id, { env: 'TOKEN=••••\nOTHER=1' });
  assert.deepStrictEqual(t.configFor([s.id]).mini.env, { TOKEN: 'abc', OTHER: '1' });
  const checked = await t.check(s.id);
  assert.ok(checked.lastCheck.ok, checked.lastCheck.error);
  assert.deepStrictEqual(checked.lastCheck.tools, ['hello', 'world']);
  assert.throws(() => t.create({ name: 'galaxy', command: 'x' }), /使う名前/);
  assert.throws(() => t.create({ name: 'mini', command: 'x' }), /同じ名前/);
  assert.throws(() => t.create({ name: 'bad name', command: 'x' }), /名前/);
  assert.throws(() => t.create({ name: 'h', type: 'http', url: 'ftp://x' }), /URL/);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(home, '.claude-galaxy', 'mcp-servers.json')).mode & 0o777, 0o600);
});

test('Claude Code の設定と skills を読む', () => {
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { gh: { command: 'npx', args: ['gh'] } } }));
  const proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(proj, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { db: { type: 'http', url: 'http://localhost:1' } } }));
  fs.writeFileSync(path.join(proj, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews code\n---\n');
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: "Deploys"\n---\n');
  assert.deepStrictEqual(claudeMcpServers(proj).map((s) => `${s.name}:${s.scope}`), ['gh:user', 'db:project']);
  const ext = claudeExtensions(proj);
  assert.deepStrictEqual(ext.map((e) => `${e.kind}:${e.name}:${e.description}`).sort(), ['agent:reviewer:Reviews code', 'skill:deploy:Deploys']);
});
