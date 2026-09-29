import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPublishRuntimeCoordinator, createAtomicBundleStore, validatePublishRuntimeBinding } from './staffdeck-publish-runtime.mjs';

const owner = { tenantId: 'tenant', actorUserId: 'user', agentId: 'agent', credentialId: 'owned-id' };
const definition = version => ({ id: 's', skill_id: 's', version, content: { skill_id: 's', version, nodes: [{ id: 'n', extension: { preserve: true } }] }, status: 'published' });
const response = version => ({ status: 200, body: { sop: definition(version), draft: { id: 'd', etag: 'old-etag' } } });
const binding = path => ({ enabled: true, definitionsPath: path, defaultSopId: 's', discoveryAgentId: 'agent', discoveryEndpoint: 'https://owner/api/v1', management: { enabled: true, agentId: 'agent', endpoint: 'https://owner/api/v1/' } });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'public-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'definitions.json');
  const bundle = { sops: [definition('1'), { id: 'other', version: '9', content: { untouched: true } }] };
  await writeFile(path, JSON.stringify(bundle));
  return { dir, path, bundle };
}

test('formal publish writes exact owner snapshot atomically; refresh ack remains unverified', async t => {
  const { dir, path, bundle } = await fixture(t);
  let publishes = 0;
  let refreshes = 0;
  const original = response('2');
  original.body.sop.id = 'owner-row-uuid';
  const coordinator = createPublishRuntimeCoordinator({ requestRefresh: async request => { refreshes++; assert.equal(request.version, '2'); return { reloaded: true }; } });
  const result = await coordinator.publish({ binding: binding(path), owner, sopId: 's', publish: async () => { publishes++; return original; } });
  assert.equal(result.body, original.body);
  assert.deepEqual(result.runtime, { status: 'awaiting-runtime-observation', ownerPublished: true, snapshotWritten: true, refreshRequested: true, effective: false, sopId: 's', version: '2' });
  const written = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(written.sops[0], { ...original.body.sop, id: 's' });
  assert.equal(result.body.sop.id, 'owner-row-uuid');
  assert.deepEqual(written.sops[1], bundle.sops[1]);
  assert.deepEqual(await readdir(dir), ['definitions.json']);
  assert.equal(publishes, 1); assert.equal(refreshes, 1);
  assert.equal(bundle.sops[0].version, '1');
});

test('publish errors keep original response and never touch runtime', async () => {
  const failure = { status: 412, body: { error: { code: 'STALE_ETAG' } } };
  const coordinator = createPublishRuntimeCoordinator({ store: { read() { assert.fail('read after failed publish'); } } });
  assert.equal(await coordinator.publish({ binding: binding('/unused'), owner, sopId: 's', publish: async () => failure }), failure);
});

test('runtime refresh failure preserves successful publish and new snapshot without retry', async t => {
  const { path } = await fixture(t);
  let calls = 0;
  const coordinator = createPublishRuntimeCoordinator({ requestRefresh: async () => { calls++; throw Object.assign(new Error('gateway unavailable'), { code: 'GATEWAY_UNAVAILABLE' }); } });
  const result = await coordinator.publish({ binding: binding(path), owner, sopId: 's', publish: async () => response('2') });
  assert.equal(result.status, 200);
  assert.equal(result.runtime.ownerPublished, true);
  assert.equal(result.runtime.snapshotWritten, true);
  assert.equal(result.runtime.effective, false);
  assert.deepEqual(result.runtime.failure, { phase: 'refresh', code: 'GATEWAY_UNAVAILABLE' });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).sops[0].version, '2');
  assert.equal(calls, 1);
});

test('owner mismatch, malformed publication and snapshot failure do not request refresh', async t => {
  const { path } = await fixture(t);
  const coordinator = createPublishRuntimeCoordinator({ requestRefresh: () => assert.fail('invalid refresh') });
  const mismatch = binding(path); mismatch.discoveryAgentId = 'other';
  let result = await coordinator.publish({ binding: mismatch, owner, sopId: 's', publish: async () => response('2') });
  assert.equal(result.runtime.failure.code, 'SOP_RUNTIME_OWNER_MISMATCH');
  result = await coordinator.publish({ binding: binding(path), owner, sopId: 'wrong-id', publish: async () => response('2') });
  assert.equal(result.runtime.failure.code, 'SOP_PUBLISH_SOURCE_MISMATCH');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).sops[0].version, '1');
  result = await coordinator.publish({ binding: binding(`${path}/absent`), owner, sopId: 's', publish: async () => response('2') });
  assert.equal(result.runtime.failure.phase, 'snapshot');
  assert.equal(result.runtime.snapshotWritten, false);
});

test('concurrent publishes serialize the owner call and snapshot in the same path', async t => {
  const { path } = await fixture(t);
  const calls = [];
  const coordinator = createPublishRuntimeCoordinator({ requestRefresh: async ({ version }) => { calls.push(`refresh-${version}`); return { reloaded: true }; } });
  await Promise.all(['2', '3'].map(version => coordinator.publish({ binding: binding(path), owner, sopId: 's', publish: async () => { calls.push(`publish-${version}`); return response(version); } })));
  assert.deepEqual(calls, ['publish-2', 'refresh-2', 'publish-3', 'refresh-3']);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).sops[0].version, '3');
});

test('single published file normalizes; JSON writer does not mutate caller bundle', async t => {
  const { path } = await fixture(t);
  await writeFile(path, JSON.stringify(definition('1')));
  const store = createAtomicBundleStore();
  assert.deepEqual(await store.read(path), { sops: [definition('1')] });
  assert.throws(() => validatePublishRuntimeBinding(binding(path), { ...owner, agentId: 'other' }), { code: 'SOP_RUNTIME_OWNER_MISMATCH' });
});
