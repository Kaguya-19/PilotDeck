import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SopStateStore } from '../../src/sop/staffdeck/SopStateStore.js';
const bundle = { sops: [{ id: 'sop', version: 'old', content: { nodes: [{ node_id: 'approval', assignee_user_id: 'approver' }] } }] };
const authority = { tenantId: 'tenant', sessionId: 'session', subject: { tenantId: 'tenant', userId: 'approver', source: 'web' as const, role: 'member' as const, disabled: false } };
async function fixture(run: (store: SopStateStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'approval-domain-'));
  try {
    const store = new SopStateStore(root);
    await store.loadOrCreate('session', bundle, 'sop');
    await store.replace('session', bundle, { status: 'handoff', active_skill_id: 'sop', active_step_id: 'approval' });
    await run(store);
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('pinned assignee and original receipt survive reload and duplicate after wait clears', () => fixture(async store => {
  const snapshot = (await store.status('session'))!;
  assert.equal(snapshot.approval!.version, 'old');
  assert.equal(snapshot.approval!.assigneeUserId, 'approver');
  const input = { sessionId: 'session', requestId: 'reply', waitId: snapshot.wait!.id, source: 'human' as const, message: 'Approved', expectedRevision: snapshot.revision, authority };
  const receipt = await store.resume(input);
  assert.equal((await store.status('session'))!.wait, undefined);
  const duplicate = await store.resume(input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.revision, receipt.revision);
  await assert.rejects(store.resume({ ...input, authority: { ...authority, subject: { ...authority.subject, userId: 'other' } } }));
  await assert.rejects(store.resume({ ...input, message: 'Different' }));
}));
test('missing auth, wrong session, wrong tenant and external source cannot clear human wait', () => fixture(async store => {
  const snapshot = (await store.status('session'))!;
  const input = { sessionId: 'session', requestId: 'reply', waitId: snapshot.wait!.id, source: 'human' as const, message: 'Reviewed', expectedRevision: snapshot.revision, authority };
  await assert.rejects(store.resume({ ...input, authority: undefined }));
  await assert.rejects(store.resume({ ...input, authority: { ...authority, sessionId: 'other' } }));
  await assert.rejects(store.resume({ ...input, authority: { ...authority, subject: { ...authority.subject, tenantId: 'other' } } }));
  await assert.rejects(store.resume({ ...input, source: 'external_task' }));
  assert.equal((await store.status('session'))!.wait!.id, snapshot.wait!.id);
}));
