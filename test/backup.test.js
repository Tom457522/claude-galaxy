'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempHome } = require('./helpers');

const home = tempHome();
const store = require('../store');
const dir = path.join(home, '.claude-galaxy');

test('バックアップ: 秘密の値は既定で伏せ、復元は次の起動時に反映する(元は .bak に残す)', () => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ busEnabled: false }));
  fs.writeFileSync(path.join(dir, 'mcp-servers.json'), JSON.stringify({ servers: [{ id: 'm1', name: 'x', env: { TOKEN: 'secret' }, headers: {} }] }));
  const b = store.exportBackup();
  assert.strictEqual(b.app, 'claude-galaxy');
  assert.strictEqual(b.files['mcp-servers.json'].servers[0].env.TOKEN, '');
  assert.strictEqual(store.exportBackup({ secrets: true }).files['mcp-servers.json'].servers[0].env.TOKEN, 'secret');

  b.files['settings.json'] = { busEnabled: true, maxConcurrentJobs: 5 };
  assert.deepStrictEqual(store.stageRestore(b).sort(), ['mcp-servers.json', 'settings.json']);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).busEnabled, false); // まだ反映しない
  assert.deepStrictEqual(store.applyPendingRestore().sort(), ['mcp-servers.json', 'settings.json']);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).maxConcurrentJobs, 5);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json.bak'), 'utf8')).busEnabled, false);
  assert.deepStrictEqual(store.applyPendingRestore(), []); // 1 回だけ
  assert.throws(() => store.stageRestore({ app: 'other', files: {} }), /バックアップではありません/);
});
