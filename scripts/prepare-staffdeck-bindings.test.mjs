import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareStaffDeckBindings } from './prepare-staffdeck-bindings.mjs';

function fixture() {
  const actor = { id: 'actor-from-response', tenant_id: 'tenant-from-response', source: 'web', role: 'admin' };
  const approver = { ...actor, id: 'approver-from-response', role: 'member' };
  const credential = { id: 'credential-from-response', user_id: actor.id, key_prefix: '01234567890123456789…',
    status: 'active', access: 'user_full_access', scopes: ['sops:read', 'sops:write', 'sops:publish', 'sops:cancel', 'knowledge:read', 'knowledge:write'] };
  return { actorLogin: { token: 'fixture-actor-token', user: actor }, actorMe: actor,
    approverLogin: { token: 'fixture-approver-token', user: approver }, approverMe: approver,
    credentialCreated: { ...credential, api_key: '01234567890123456789fixture-only' }, credentials: [credential],
    target: { id: 'target-from-response', tenant_id: actor.tenant_id, status: 'active', is_overall: false },
    pilotDeckLogin: { success: true, token: 'fixture-pd-token', user: { id: 17 } }, pilotDeckMe: { user: { id: 17 } },
    staffDeckOrigin: 'http://127.0.0.1:16400', pilotDeckGatewayUrl: 'ws://127.0.0.1:16411/ws',
    pilotDeckGatewayTokenPath: '/isolated-home/server-token',
    definitionsPath: 'sops/acceptance.yaml', defaultSopId: 'project_delivery_plan' };
}

test('actual response IDs bind copy, management and discovery without claiming readiness', () => {
  const result = prepareStaffDeckBindings(fixture());
  assert.equal(result.env.STAFFDECK_COPY_PILOTDECK_USER_ID, '17');
  assert.equal(result.env.STAFFDECK_APPROVAL_USER_ID, result.identity.approverUserId);
  assert.equal(result.env.PILOTDECK_GATEWAY_URL, 'ws://127.0.0.1:16411/ws');
  assert.equal(result.env.PILOTDECK_GATEWAY_TOKEN_PATH, '/isolated-home/server-token');
  assert.equal(result.env.STAFFDECK_PUBLIC_ORIGIN, result.env.STAFFDECK_FORMAL_API_ORIGIN);
  assert.equal(result.env.STAFFDECK_KNOWLEDGE_READ_KEY, result.env.STAFFDECK_SOP_MANAGEMENT_API_KEY);
  assert.equal(result.env.STAFFDECK_FIXED_TARGET_AGENT_ID, result.identity.targetAgentId);
  assert.equal(result.env.STAFFDECK_PUBLISHED_SOP_BUNDLE_PATH, result.configPatch.modules.sop.definitionsPath);
  assert.equal(result.configPatch.modules.sop.discoveryAgentId, result.identity.targetAgentId);
  assert.deepEqual(result.configPatch.modules.knowledge, {
    tenantId: result.identity.tenantId,
    actorUserId: result.identity.actorUserId,
    agentId: result.identity.targetAgentId,
  });
  assert.equal(result.configPatch.modules.sop.discoveryEndpoint, result.env.STAFFDECK_SOP_MANAGEMENT_ENDPOINT);
  assert.equal(result.readiness.effectiveProfile, false);
  assert.equal(result.readiness.approvalPrincipalMapping, 'NOT_CONFIGURED');
  assert.ok(!JSON.stringify(result.identity).includes('fixture-actor-token'));
});

test('foreign target and inconsistent current identities are rejected', () => {
  for (const mutate of [input => { input.target.tenant_id = 'foreign'; },
    input => { input.actorLogin.user = { ...input.actorMe, id: 'another' }; },
    input => { input.pilotDeckMe.user.id = 18; },
    input => { input.pilotDeckLogin.user.id = input.pilotDeckMe.user.id = null; }]) {
    const input = fixture(); mutate(input); assert.throws(() => prepareStaffDeckBindings(input));
  }
});

test('foreign, revoked, expired and missing-scope credentials cannot produce a binding', () => {
  for (const mutate of [row => { row.user_id = 'foreign'; }, row => { row.revoked_at = '2026-09-27'; },
    row => { row.expires_at = '2026-09-27'; }, row => { row.scopes = row.scopes.filter(scope => scope !== 'sops:cancel'); },
    row => { row.expires_at = 'invalid-date'; }]) {
    const input = fixture(); mutate(input.credentials[0]);
    assert.throws(() => prepareStaffDeckBindings(input, { now: Date.parse('2026-09-28') }));
  }
});

test('native member mapping rejects external source, other tenant and disabled approver', () => {
  for (const mutate of [row => { row.source = 'external'; }, row => { row.tenant_id = 'foreign'; }, row => { row.disabled = true; }]) {
    const input = fixture(); mutate(input.approverMe); assert.throws(() => prepareStaffDeckBindings(input));
  }
});

test('minimum path can omit deferred approval but cannot accept a partial approver tuple', () => {
  const input = fixture();
  delete input.approverLogin;
  delete input.approverMe;
  const result = prepareStaffDeckBindings(input);
  assert.equal(result.env.PILOTDECK_USER_ID, result.identity.pilotDeckUserId);
  assert.equal(result.env.PILOTDECK_DOMAIN_HOST_ENABLED, 'true');
  assert.equal(result.env.STAFFDECK_APPROVAL_USER_ID, undefined);
  assert.equal(result.identity.approverUserId, undefined);
  input.approverMe = fixture().approverMe;
  assert.throws(() => prepareStaffDeckBindings(input), /NATIVE_APPROVER_MISMATCH/);
});

test('origin with credentials, unrelated path or query cannot become a formal owner endpoint', () => {
  for (const origin of ['http://user:secret@localhost:16400', 'http://localhost:16400/unrelated', 'http://localhost:16400/?secret=value']) {
    const input = fixture(); input.staffDeckOrigin = origin; assert.throws(() => prepareStaffDeckBindings(input));
  }
});

test('domain callback needs an explicit normal Gateway origin and token path', () => {
  for (const mutate of [
    input => { delete input.pilotDeckGatewayUrl; },
    input => { delete input.pilotDeckGatewayTokenPath; },
    input => { input.pilotDeckGatewayUrl = 'ws://user:secret@127.0.0.1:16411/ws'; },
    input => { input.pilotDeckGatewayUrl = 'ws://127.0.0.1:16411/other'; },
    input => { input.pilotDeckGatewayTokenPath = 'relative/server-token'; },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => prepareStaffDeckBindings(input), /PILOTDECK_GATEWAY_BINDING_/);
  }
});
