'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tempHome } = require('./helpers');

tempHome();
const { createBus } = require('../bus');
const { createAgents } = require('../agents');

function setup() {
  const bus = createBus({ onChange() {} });
  const jobList = [
    { id: 'j1', name: '棚卸し', status: 'running', memoryReview: true, cwd: '/' },
    { id: 'j2', name: 'ふつう', status: 'running', cwd: '/' },
  ];
  const jobs = { get: (id) => jobList.find((j) => j.id === id), list: () => jobList };
  const agents = createAgents({ sessions: new Map(), jobs, bus, maxDepth: 3, maxAgentJobs: 20 });
  return { bus, agents };
}

test('棚卸しのジョブは、読む・候補を出す・人に知らせることしかできない', async () => {
  const { bus, agents } = setup();
  bus.memWrite('k', 'v');
  assert.strictEqual((await agents.busCall('j1', 'memory_search', { query: '' })).length, 1);
  assert.strictEqual((await agents.busCall('j1', 'memory_read', { key: 'k' })).value, 'v');
  assert.match((await agents.busCall('j1', 'memory_propose', { action: 'delete', key: 'k', reason: '古い' })).candidate, /^c\d+$/);
  assert.ok((await agents.busCall('j1', 'send_message', { to: 'user', text: '終わりました' })).sent);
  await assert.rejects(agents.busCall('j1', 'memory_write', { key: 'k', value: 'x' }), /使えません/);
  await assert.rejects(agents.busCall('j1', 'memory_delete', { key: 'k' }), /使えません/);
  await assert.rejects(agents.busCall('j1', 'submit_job', { prompt: 'x' }), /使えません/);
  await assert.rejects(agents.busCall('j1', 'send_message', { to: 'j2', text: 'x' }), /人/);
  assert.strictEqual(bus.memRead('k').value, 'v');
});

test('ふつうのジョブの memory_write は未確認になり、必須は書き換えられない', async () => {
  const { bus, agents } = setup();
  const m = await agents.busCall('j2', 'memory_write', { key: 'a', value: 'b' });
  assert.strictEqual(m.verified, false);
  bus.memWrite('must', 'x', { meta: { priority: 'must' } });
  await assert.rejects(agents.busCall('j2', 'memory_write', { key: 'must', value: 'y' }), /memory_propose/);
  const brief = await agents.busCall('j2', 'memory_search', { query: '', brief: true, limit: 1 });
  assert.strictEqual(brief.length, 1);
  assert.ok('length' in brief[0]);
});
