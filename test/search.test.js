'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempHome } = require('./helpers');

const home = tempHome();
const { search, strip } = require('../search');

test('画面出力の制御文字を取り除いて探す', () => {
  assert.strictEqual(strip('\x1b[38;2;1;2;3mHello\x1b[0m \x1b]0;title\x07World\r\n'), 'Hello World\n');
  const dir = path.join(home, '.claude-galaxy', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's1.log'), 'first line\r\n\x1b[1mDeploy\x1b[0m finished OK\r\nother\r\n');
  const hits = search('deploy ok', {
    sessions: () => [{ id: 's1', name: 'lead' }],
    jobs: () => [{ id: 'j1', name: 'job', prompt: 'deploy the app', result: 'all ok', error: '' }],
    transcript: () => [{ kind: 'text', text: 'deploy step ok' }],
    messages: () => [{ id: 'm1', from: 's1', fromName: 'lead', to: 'user', text: 'Deploy is ok' }],
    memory: () => [{ key: 'proj/deploy', value: 'ok to deploy', tags: [] }],
  });
  assert.deepStrictEqual(hits.map((h) => h.kind), ['session', 'job', 'message', 'memory']);
  assert.match(hits[0].snippet, /Deploy finished OK/);
  assert.deepStrictEqual(search('', { sessions: () => [], jobs: () => [], transcript: () => [], messages: () => [], memory: () => [] }), []);
});
