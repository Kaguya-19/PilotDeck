import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixedApprovalAuthority } from './staffdeck-approval-authority.mjs';
const wait = { sessionId: 'session', revision: 7, wait: { id: 'wait', kind: 'handoff' } };
const input = { bearer: 'approver-token', wait, requestId: 'reply-1', message: 'Reviewed', expectedRevision: 7 };
const user = { id: 'approver', tenant_id: 'tenant', source: 'web', role: 'member', disabled: false };
function authority(fetch) { return createFixedApprovalAuthority({ origin: 'http://localhost:16400', tenantId: 'tenant', approverUserId: 'approver', fetch }); }
test('normal current-user identity binds original wait and revision without resuming', async () => {
  const signal = new AbortController().signal;
  const result = await authority(async (url, request) => {
    assert.equal(url.pathname, '/api/auth/me');
    assert.equal(request.headers.authorization, 'Bearer approver-token');
    assert.equal(request.signal, signal);
    return Response.json(user);
  }).authorize({ ...input, signal });
  assert.deepEqual(result.command, { sessionKey: 'session', requestId: 'reply-1', waitId: 'wait', source: 'human', message: 'Reviewed', expectedRevision: 7 });
  assert.equal(result.subject.userId, 'approver');
});
test('different actor, tenant, disabled or nonnative subject cannot approve', async () => {
  for (const difference of [{ id: 'actor' }, { tenant_id: 'other' }, { disabled: true }, { source: 'channel' }]) {
    await assert.rejects(authority(async () => Response.json({ ...user, ...difference })).authorize(input), error => error.status === 403);
  }
});
test('invalid command and external task are rejected before authentication', async () => {
  const guard = authority(async () => { throw new Error('must not authenticate'); });
  await assert.rejects(guard.authorize({ ...input, expectedRevision: -1 }), error => error.status === 400);
  await assert.rejects(guard.authorize({ ...input, wait: { ...wait, wait: { id: 'wait', kind: 'external_task' } } }), error => error.status === 400);
});
test('original authentication failure status is preserved', async () => {
  await assert.rejects(authority(async () => new Response('', { status: 401 })).authorize(input), error => error.status === 401);
});

test('identity authentication does not require pending wait for receipt replay', async () => {
  const result = await authority(async () => Response.json(user)).authorize({ bearer: 'approver-token', sessionKey: 'session', waitId: 'original', requestId: 'reply-1', message: 'Reviewed', expectedRevision: 7 });
  assert.equal(result.command.waitId, 'original');
});
